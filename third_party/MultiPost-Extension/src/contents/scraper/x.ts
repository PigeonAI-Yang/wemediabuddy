import type { ArticleData } from "./default";

export default async function scrapeXContent(): Promise<ArticleData | undefined> {
  const title =
    document.querySelector("div[data-testid='twitter-article-title']")?.textContent?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    "";
  const author = document.querySelector("div[data-testid='User-Name'] a")?.textContent?.trim() || "";
  let content = "";

  for (let attempt = 0; attempt < 10; attempt++) {
    const contentElement = document.querySelector<HTMLElement>("div[data-testid='longformRichTextComponent'] > div");
    if (contentElement?.textContent?.trim()) {
      content = contentElement.innerHTML.trim();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!title || !content) return;

  return {
    title,
    author,
    cover: document.querySelector('div[data-testid="tweetPhoto"] img')?.getAttribute("src") || "",
    content,
    digest: document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "",
  };
}
