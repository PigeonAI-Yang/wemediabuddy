import type { ArticleData } from "./default";
import { preprocessor } from "./preprocessor";

function normalizeContent(content: string): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  doc.querySelectorAll("div.ne-ui-image-ocr-mask, button").forEach((element) => element.remove());
  const normalizedTags = doc.body.innerHTML.replace(/<ne-/g, "<").replace(/<\/ne-/g, "</");
  return preprocessor(normalizedTags);
}

export default async function scrapeYuqueContent(): Promise<ArticleData | undefined> {
  const title = document.querySelector("h1#article-title")?.textContent?.trim() || "";
  const content = document.querySelector("div.yuque-doc-content")?.innerHTML?.trim() || "";
  if (!title || !content) return;

  return {
    title,
    author: "",
    cover: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    content: normalizeContent(content),
    digest: document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || "",
  };
}
