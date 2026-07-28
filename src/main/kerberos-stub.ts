export async function initializeClient(): Promise<never> {
  throw new Error('WMB 不支持 Kerberos 代理认证。');
}
