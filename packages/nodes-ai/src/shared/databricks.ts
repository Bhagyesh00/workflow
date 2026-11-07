/**
 * The base URL of a Databricks workspace's OpenAI-compatible AI gateway. Token calls to this host carry
 * the client secret, so anything but plain https is refused. The error never repeats the host.
 */
import { trimSlash } from './chat-model';

export function databricksGatewayUrl(host: string): string {
  const base = trimSlash(host);
  let url: URL | undefined;
  try {
    url = new URL(base);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The Databricks host must be an https URL, such as https://<workspace>.cloud.databricks.com',
    );
  }
  return `${base}/ai-gateway/openai/v1`;
}
