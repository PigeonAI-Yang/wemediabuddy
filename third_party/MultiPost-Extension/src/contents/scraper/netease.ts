import { scrapeConfiguredSite } from "./site";

export default async function scrapeNeteaseContent() {
  return scrapeConfiguredSite({
    label: "netease",
    title: [{ selector: "h1.post_title" }],
    author: [{ selector: ".post_info > a" }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ["div.post_body"],
    digest: [{ selector: 'meta[property="og:description"]', attribute: "content" }],
  });
}
