/**
 * P6-01: the SSO part of the sign-in page (above the password form): asks `authApi.ssoOptions(workspace)`,
 * shows the provider's button, sends the browser to the provider when `redirect` is on, shows `?ssoError=`.
 */
export interface SsoSignInProps {
  /** the workspace slug (`?workspace=`); absent = none given yet */
  workspace?: string;
  /** the safe same-app path to return to after sign-in */
  redirect?: string;
}

export function SsoSignIn(_props: SsoSignInProps) {
  // stub (L6)
  return null;
}
