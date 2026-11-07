/**
 * Which hosts may receive an AWS request signature. One rule for every signer: the AWS credentials, the
 * signer in core and the Bedrock endpoints all end here. A signature gives away the access key id (and a
 * session token), so it goes only to the API hosts of AWS services, never to a host a customer runs under
 * amazonaws.com (EC2 and load balancer names, API Gateway, AppSync, S3 sites and buckets, RDS and so on).
 *
 * The shapes that pass: `<service>.amazonaws.com`, `<service>.<region>.amazonaws.com`,
 * `<service>.dualstack.<region>.amazonaws.com` and the VPC endpoint form
 * `[vpce-<id>.]<service>.<region>.vpce.amazonaws.com`, each also under `amazonaws.com.cn`.
 * Pure function, no node: imports: this file is bundled by the editor as well.
 */

export const AWS_SIGNABLE_HOST =
  /^(?:vpce-[a-z0-9-]+\.)?[a-z0-9-]+\.(?:dualstack\.)?(?:[a-z]{2}(?:-[a-z]+)+-\d\.)?(?:vpce\.)?amazonaws\.com(?:\.cn)?$/i;

/** fixed text: it never holds the URL, since a query string can carry a secret */
export const AWS_HOST_REFUSED = 'AWS credentials only sign https requests to amazonaws.com hosts';

/** https, no user info and a host from the list above */
export function isSignableAwsUrl(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return (
    target.protocol === 'https:' &&
    target.username === '' &&
    target.password === '' &&
    AWS_SIGNABLE_HOST.test(target.hostname)
  );
}

export function assertSignableAwsUrl(url: string): void {
  if (!isSignableAwsUrl(url)) throw new Error(AWS_HOST_REFUSED);
}
