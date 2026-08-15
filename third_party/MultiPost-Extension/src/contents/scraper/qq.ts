import { scrapeConfiguredSite } from "./site";

export default async function scrapeQqNewsContent() {
  return scrapeConfiguredSite({
    label: "qq-news",
    title: [{ selector: "div.content-article > h1" }],
    author: [{ selector: 'meta[property="article:author"]', attribute: "content" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.article-content-wrap"],
    digest: [{ selector: 'meta[property="og:description"]', attribute: "content" }],
  });
}
