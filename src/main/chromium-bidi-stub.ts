const unsupported = () => { throw new Error('WMB 仅使用 CDP，不启用 WebDriver BiDi。'); };

export const BidiServer = { createAndStart: unsupported };
export class MapperCdpConnection { constructor() { unsupported(); } }
