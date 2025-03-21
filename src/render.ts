import fs from "fs-extra";
import {
    Client,
    isFullPage,
    isFullUser,
    iteratePaginatedAPI,
} from "@notionhq/client";
import {
    EquationBlockObjectResponse,
    GetPageResponse,
    PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { NotionToMarkdown } from "@pclouddev/notion-to-markdown";
import YAML from "yaml";
import { sh } from "./sh";
import { DatabaseMount, loadConfig, PageMount } from "./config";
import { getPageTitle, getCoverLink, getFileName, saveImage } from "./helpers";
import katex from "katex";
import { MdBlock } from "@pclouddev/notion-to-markdown/build/types";
import path from "path";
import { getContentFile } from "./file";
require("katex/contrib/mhchem"); // modify katex module

function getExpiryTime(blocks: MdBlock[], expiry_time: string | undefined = undefined): string | undefined {
    for (const block of blocks) {
        if (block.expiry_time !== undefined) {
            if (expiry_time === undefined) expiry_time = block.expiry_time
            else expiry_time = expiry_time < block.expiry_time ? expiry_time : block.expiry_time
        }
        if (block.children.length > 0) {
            const child_expiry_time = getExpiryTime(block.children, expiry_time)
            if (child_expiry_time) {
                if (expiry_time === undefined) expiry_time = child_expiry_time
                else expiry_time = expiry_time < child_expiry_time ? expiry_time : child_expiry_time
            }
        }
    }
    return expiry_time
}

export async function renderPage(page: PageObjectResponse, notion: Client) {

    // load formatter config
    const formatterConfig = (await loadConfig()).formatter;
    formatterConfig.equation.style

    const n2m = new NotionToMarkdown({ notionClient: notion });
    let frontInjectString = ''

    switch (formatterConfig.equation.style) {
        case 'markdown':
            n2m.setCustomTransformer("equation", async (block) => {
                const { equation } = block as EquationBlockObjectResponse;
                return `\\[${equation}\\]`;
            });
            break;
        case 'shortcode':
            n2m.setCustomTransformer("equation", async (block) => {
                const { equation } = block as EquationBlockObjectResponse;
                return `{{< math >}}\\[${equation}\\]{{< /math >}}`
            })
            break;
        case 'html':
            n2m.setCustomTransformer("equation", async (block) => {
                const { equation } = block as EquationBlockObjectResponse;
                const html = katex.renderToString(equation.expression, {
                    throwOnError: false,
                    displayMode: true,
                });
                return html;
            });
            frontInjectString += `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.2/dist/katex.min.css" integrity="sha384-bYdxxUwYipFNohQlHt0bjN/LCpueqWz13HufFEV1SUatKs1cm4L6fFgCi1jT643X" crossorigin="anonymous">\n`
            break
        default:
            console.warn('[Warn] invalid notion.toml config')
            break;
    }
    n2m.setCustomTransformer('image', async (block) => {
        const { image } = block as any;
        const url = image.file?.url as string | undefined;
        console.log('image url', url);
        
        if (!url) {
            console.error(`[Error] image url is not found`);
            return '';
        }
        const filepath = await saveImage(url, 'static/imgs');
        console.log('filepath', filepath);
        return `![](/${filepath?.replace('static/', '')})`;
    });

    n2m.setCustomTransformer('video', async (block) => {
        const { video } = block as any;
        console.info(`video: ${JSON.stringify(video)}`);
        if (video?.external?.url) {
            return `<video style="width: 100%; height: auto;" src="${video?.external?.url}" controls></video>`;
        } else if (video?.file?.url) {
            return `<video style="width: 100%; height: auto;" src="${video?.file?.url}" controls></video>`;
        } else {
            return '';
        }
    });

    n2m.setCustomTransformer('audio', async (block) => {
        const { audio } = block as any;
        console.info(`audio: ${JSON.stringify(audio)}`);
        if (audio?.external?.url) {
            return `<audio style="width: 100%; height: auto;" controls><source src="${audio?.external?.url}"></audio>`;
        } else if (audio?.file?.url) {
            return `<audio style="width: 100%; height: auto;" controls><source src="${audio?.file?.url}"></audio>`;
        } else {
            return '';
        }
        return '';
    });

    n2m.setCustomTransformer('bookmark', async (block) => {
        const { bookmark } = block as any;
        console.info(`bookmark: ${JSON.stringify(bookmark)}`);
        if (!bookmark?.url) {
            return '';
        }

        return `<a href="${bookmark?.url}">${bookmark?.url}</a>`;
    });

    n2m.setCustomTransformer('link_preview', async (block) => {
        const { link_preview } = block as any;
        console.info(`link_preview: ${JSON.stringify(link_preview)}`);
        if (!link_preview?.url) {
            return '';
        }

        return `<a href="${link_preview?.url}">${link_preview?.url}</a>`;
    });

    let nearest_expiry_time: string | null = null
    const mdblocks = await n2m.pageToMarkdown(page.id);
    const page_expiry_time = getExpiryTime(mdblocks)
    if (page_expiry_time) nearest_expiry_time = page_expiry_time
    const mdString = n2m.toMarkdownString(mdblocks);
    page.properties.Name;
    const title = getPageTitle(page);
    const frontMatter: Record<
        string,
        string | string[] | number | boolean | PageObjectResponse
    > = {
        title,
        date: page.created_time,
        lastmod: page.last_edited_time,
        draft: false,
    };

    // set featuredImage
    const featuredImageLink = await getCoverLink(page.id, notion);
    if (featuredImageLink) {
        const { link, expiry_time } = featuredImageLink;
        const filepath = await saveImage(link, 'static/imgs');
        console.log('filepath', filepath);
        if (filepath === undefined) {
            console.error(`[Error] failed to save image ${link}`);
            process.exit(1);
        }
        frontMatter.image = '/' + filepath.replace('static/', '');
        // update nearest_expiry_time
        if (expiry_time) {
            if (nearest_expiry_time) {
                nearest_expiry_time = expiry_time < nearest_expiry_time ? expiry_time : nearest_expiry_time
            } else {
                nearest_expiry_time = expiry_time
            }
        }
    }

    // map page properties to front matter
    for (const property in page.properties) {
        console.info(`page property: ${property} ${JSON.stringify(page.properties[property])}`);
        const id = page.properties[property].id;
        const response = await notion.pages.properties.retrieve({
            page_id: page.id,
            property_id: id,
        });
        if (response.object === "property_item") {
            switch (response.type) {
                case "checkbox":
                    frontMatter[property] = response.checkbox;
                    break;
                case "select":
                    if (response.select?.name)
                        frontMatter[property] = response.select?.name;
                    break;
                case "multi_select":
                    if (property === "keywords") {
                        frontMatter[property] = response.multi_select.map((select) => select.name).join(", ");
                    } else {
                        frontMatter[property] = response.multi_select.map(
                            (select) => select.name
                        );
                    }
                    break;
                case "email":
                    if (response.email) frontMatter[property] = response.email;
                    break;
                case "url":
                    if (response.url) frontMatter[property] = response.url;
                    break;
                case "date":
                    if (response.date?.start)
                        frontMatter[property] = response.date?.start;
                    break;
                case "number":
                    if (response.number) frontMatter[property] = response.number;
                    break;
                case "phone_number":
                    if (response.phone_number)
                        frontMatter[property] = response.phone_number;
                    break;
                case "status":
                    if (response.status?.name)
                        frontMatter[property] = response.status?.name;
                // ignore these properties
                case "last_edited_by":
                case "last_edited_time":
                case "rollup":
                case "files":
                case "formula":
                case "created_by":
                case "created_time":
                    break;
                default:
                    break;
            }
        } else {
            for await (const result of iteratePaginatedAPI(
                // @ts-ignore
                notion.pages.properties.retrieve,
                {
                    page_id: page.id,
                    property_id: id,
                }
            )) {
                switch (result.type) {
                    case "people":
                        frontMatter[property] = frontMatter[property] || [];
                        if (isFullUser(result.people)) {
                            const fm = frontMatter[property];
                            if (Array.isArray(fm) && result.people.name) {
                                fm.push(result.people.name);
                            }
                        }
                        break;
                    case "rich_text":
                        frontMatter[property] = frontMatter[property] || "";
                        frontMatter[property] += result.rich_text.plain_text;
                    // ignore these
                    case "relation":
                    case "title":
                    default:
                        break;
                }
            }
        }
    }

    // set default author
    if (frontMatter.author == null) {
        const response = await notion.users.retrieve({
            user_id: page.last_edited_by.id,
        });
        if (response.name) {
            frontMatter.author = response.name;
        }
    }
    if (Array.isArray(frontMatter.author)) {
        frontMatter.author = frontMatter.author.join(", ");
    }

    // save metadata
    frontMatter.NOTION_METADATA = page;

    // save update time
    frontMatter.UPDATE_TIME = (new Date()).toISOString()
    // save nearest expiry time
    if (nearest_expiry_time) frontMatter.EXPIRY_TIME = nearest_expiry_time



    return {
        title,
        pageString:
            "---\n" +
            YAML.stringify(frontMatter, {
                defaultStringType: "QUOTE_DOUBLE",
                defaultKeyType: "PLAIN",
            }) +
            "\n---\n" +
            frontInjectString + '\n' +
            mdString,
    };
}

export async function savePage(
    page: PageObjectResponse,
    notion: Client,
    mount: DatabaseMount | PageMount
) {
    // Notionのプロパティから下書き状態を確認
    const isDraft = await checkIfDraft(page, notion);
    
    // 下書きの場合はスキップ
    if (isDraft) {
        console.info(`[Info] Skipping draft page: ${getPageTitle(page)}`);
        return;
    }
    
    const postpath = path.join(
        "content",
        mount.target_folder,
        getFileName(getPageTitle(page), page.id)
    );
    const post = getContentFile(postpath);
    if (post) {
        const metadata = post.metadata;
        // if the page is not modified, continue
        if (post.expiry_time == null && metadata.last_edited_time === page.last_edited_time) {
            console.info(`[Info] The post ${postpath} is up-to-date, skipped.`);
            return;
        }
    }
    // otherwise update the page
    console.info(`[Info] Updating ${postpath}`);

    const { title, pageString } = await renderPage(page, notion);
    console.info(`[Info] pagestring ${pageString}`);
    const fileName = getFileName(title, page.id);
    await sh(
        `hugo new "${mount.target_folder}/${fileName}"`,
        false
    );
    fs.writeFileSync(`content/${mount.target_folder}/${fileName}`, pageString);
}

// 下書きかどうかを判断する関数を追加
async function checkIfDraft(page: PageObjectResponse, notion: Client): Promise<boolean> {
    // Notionのプロパティを確認
    for (const property in page.properties) {
        const prop = page.properties[property];
        
        // 「Status」または「状態」プロパティを探す
        if (
            (property.toLowerCase() === 'status' || 
             property.toLowerCase() === '状態' || 
             property.toLowerCase() === 'draft') && 
            prop.type === 'status'
        ) {
            const id = prop.id;
            const response = await notion.pages.properties.retrieve({
                page_id: page.id,
                property_id: id,
            });
            
            if (response.object === "property_item" && response.type === "status") {
                // 「下書き」「Draft」などの値をチェック
                const status = response.status?.name?.toLowerCase();
                return status === 'draft' || status === '下書き' || status === 'ドラフト';
            }
        }
        
        // チェックボックスタイプの「Draft」プロパティをチェック
        if (
            (property.toLowerCase() === 'draft' || 
             property.toLowerCase() === '下書き') && 
            prop.type === 'checkbox'
        ) {
            const id = prop.id;
            const response = await notion.pages.properties.retrieve({
                page_id: page.id,
                property_id: id,
            });
            
            if (response.object === "property_item" && response.type === "checkbox") {
                return response.checkbox === true;
            }
        }
    }
    
    // デフォルトでは下書きではない
    return false;
}