import type { ArticleData } from "./default";
import { preprocessor } from "./preprocessor";

interface ValueSelector {
  selector: string;
  attribute?: string;
}

export interface SiteScraperConfig {
  label: string;
  title: ValueSelector[];
  author?: ValueSelector[];
  cover?: ValueSelector[];
  content: string[];
  digest?: ValueSelector[];
}

function readFirst(selectors: ValueSelector[] | undefined): string {
  for (const candidate of selectors ?? []) {
    const element = document.querySelector(candidate.selector);
    const value = candidate.attribute ? element?.getAttribute(candidate.attribute) : element?.textContent;
    if (value?.trim()) return value.trim();
  }
  return "";
}

function readHtml(selectors: string[]): string {
  for (const selector of selectors) {
    const content = document.querySelector(selector)?.innerHTML;
    if (content?.trim()) return content.trim();
  }
  return "";
}

function normalizeUrl(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

export async function scrapeConfiguredSite(config: SiteScraperConfig): Promise<ArticleData | undefined> {
  console.debug(`${config.label} spider ...`);

  const title = readFirst(config.title);
  const content = readHtml(config.content);
  if (!title || !content) {
    console.log("failedToGetArticleContent");
    return;
  }

  return {
    title,
    author: readFirst(config.author),
    cover: normalizeUrl(readFirst(config.cover)),
    content: preprocessor(content),
    digest: readFirst(config.digest),
  };
}
