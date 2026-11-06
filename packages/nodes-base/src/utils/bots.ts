/** the Ignore Bots option of the Webhook node and the forms */
export function isBotUserAgent(userAgent: string | undefined): boolean {
  return /bot|crawler|spider|preview|facebookexternalhit|whatsapp|curl|wget|python|go-http|java\/|okhttp|headless|microsoft office/i.test(
    userAgent ?? '',
  );
}
