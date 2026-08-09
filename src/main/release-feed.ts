const ACCEPTANCE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function buildAcceptanceFeedUrl(tag: string | undefined): string | undefined {
  const normalized = tag?.trim();
  if (!normalized) return undefined;
  const match = ACCEPTANCE_TAG.exec(normalized);
  const invalidPrerelease = match?.[1]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
  if (!match || invalidPrerelease) {
    throw new Error('WMB_ACCEPTANCE_UPDATE_TAG 必须是 v<semver>，例如 v0.2.0。');
  }
  return `https://github.com/PigeonAI-Yang/wemediabuddy/releases/download/${normalized}`;
}
