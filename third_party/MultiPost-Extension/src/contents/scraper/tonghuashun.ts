import { scrapeConfiguredSite } from "./site";

export default async function scrapeTonghuashunContent() {
  return scrapeConfiguredSite({
    label: "tonghuashun",
    title: [{ selector: "div.detail-title" }],
    author: [{ selector: "a.post-author" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.post-text-main"],
  });
}
