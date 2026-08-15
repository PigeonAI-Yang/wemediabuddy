import { scrapeConfiguredSite } from "./site";

export default async function scrapeBaijiahaoContent() {
  return scrapeConfiguredSite({
    label: "baijiahao",
    title: [{ selector: "div#header" }],
    author: [{ selector: 'span[data-testid="author-name"]' }],
    cover: [{ selector: 'meta[property="og:image"]', attribute: "content" }],
    content: ['div[data-testid="article"]'],
    digest: [{ selector: 'meta[name="description"]', attribute: "content" }],
  });
}
