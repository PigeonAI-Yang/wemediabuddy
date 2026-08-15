import type { ArticleData } from "./default";

function waitForElement(selector: string, timeout = 10000): Promise<Element> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element with selector "${selector}" not found within ${timeout}ms`));
    }, timeout);
  });
}

function normalizeContent(content: string): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  doc.querySelectorAll("img").forEach((image) => {
    if (!image.referrerPolicy) image.referrerPolicy = "no-referrer";
    const src = image.getAttribute("src");
    if (src && !/^https?:/i.test(src)) {
      image.src = new URL(src, window.location.href).href;
    }
  });
  return doc.body.innerHTML;
}

export default async function scrapeNotionContent(): Promise<ArticleData | undefined> {
  const contentElement = await waitForElement("div.notion-page-content");
  const title = document.querySelector("title")?.textContent?.trim() || "";
  const content = contentElement.innerHTML.trim();
  if (!title || !content) return;

  return {
    title,
    author: "",
    cover: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    content: normalizeContent(content),
    digest: "",
  };
}
