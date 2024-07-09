import { Client, isFullPage } from "@notionhq/client";
import {
  PageObjectResponse
} from "@notionhq/client/build/src/api-endpoints";
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

const allowedExtensions = ['jpg', 'jpeg', 'png'] as const;
type AllowedExtension = typeof allowedExtensions[number];
const isAllowedExtension = (extension: string): extension is AllowedExtension => allowedExtensions.includes(extension as AllowedExtension);

//画像変換処理の設定
const sharpOptions = {
  'jpg' : [
    'jpg',
    {
      quality: 90,
      progressive: true
    }
  ] as const,
  'jpeg' : [
    'jpg',
    {
      quality: 90,
      progressive: true
    }
  ] as const,
  'png' : [
    'png',
    {
      quality: 80,
    }
  ] as const
}


export async function saveImage(url: string, basePath: string) {
  const filename = (new URL(url)).pathname.split('/').pop();
  const extension = filename?.split('.').pop();
  if (filename === undefined || extension === undefined) {
    console.error(`Failed to parse filename from URL: ${url}`);
    return;
  }
  const newFilename = `${uuidv4()}.${extension}`;
  const tmpFilePath = path.join(basePath, newFilename);
  const filepath = tmpFilePath.replace(/\.(jpg|jpeg|png)$/i, '.webp');
  const response = await axios.get(url, { responseType: 'arraybuffer' });

  try {
    await fs.writeFile(tmpFilePath, response.data);
  } catch (err) {
    console.error('Failed to save image:', err);
    return;
  }

  if (isAllowedExtension(extension)) {
    const convertFormat = sharpOptions[extension];
    console.log('convert format', convertFormat);
    sharp(tmpFilePath)
      .toFormat(convertFormat[0])
      .toFile(filepath, (err) => {
       if (err) {
          console.error('Error processing image:', err, tmpFilePath);
        } else {
          console.log('convert iamge:', tmpFilePath, 'to', filepath);
        }
      });
  }
  
  return filepath;
}

export function getPageTitle(page: PageObjectResponse): string {
  const title = page.properties.Name ?? page.properties.title;
  if (title.type === "title") {
    return title.title.map((text) => text.plain_text).join("");
  }
  throw Error(
    `page.properties.Name has type ${title.type} instead of title. The underlying Notion API might has changed, please report an issue to the author.`
  );
}

export async function getCoverLink(
  page_id: string,
  notion: Client
): Promise<{ link: string, expiry_time: string | null } | null> {
  const page = await notion.pages.retrieve({ page_id });
  if (!isFullPage(page)) return null;
  if (page.cover === null) return null;
  if (page.cover.type === "external") return {
    link: page.cover.external.url,
    expiry_time: null
  };
  else return {
    link: page.cover.file.url,
    expiry_time: page.cover.file.expiry_time
  };
}

export function getFileName(title: string, page_id: string): string {
  return title.replaceAll(" ", "-").replace(/--+/g, "-") +
    "-" +
    page_id.replaceAll("-", "") + '.md';
}