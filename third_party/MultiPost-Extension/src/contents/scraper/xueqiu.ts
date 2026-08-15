import { scrapeConfiguredSite } from "./site";

export default async function scrapeXueqiuContent() {
  return scrapeConfiguredSite({
    label: "xueqiu",
    title: [{ selector: "h1.article__bd__title" }],
    author: [{ selector: ".avatar__name > a" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.article__bd__detail"],
    digest: [{ selector: 'meta[name="description"]', attribute: "content" }],
  });
}
