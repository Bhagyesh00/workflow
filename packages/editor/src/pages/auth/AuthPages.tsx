/** Sign in, create a workspace, accept an invitation. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { authApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { AuthResult, LoginBody, MfaLoginInput } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';
import { MfaStep } from './MfaStep';
import { SsoSignIn } from './SsoSignIn';

/** Only same-app relative paths are accepted as post-login redirects. */
export function safeRedirect(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/workflows';
  return value;
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Include at least one letter and one digit';
  return null;
}

function useAuthSuccess() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  return async (result: AuthResult) => {
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    void result;
    navigate(safeRedirect(search.get('redirect')), { replace: true });
  };
}

export function LoginPage() {
  const onSuccess = useAuthSuccess();
  const [search] = useSearchParams();
  const workspace = search.get('workspace') || undefined;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // P6-18: the password matched and the account has MFA on: ask for the second step
  const [mfaStep, setMfaStep] = useState(false);
  const login = useMutation({
    mutationFn: (body: LoginBody) => authApi.login(body),
    onSuccess,
    onError: (error) => {
      if (isApiError(error, 401) && error.code === 'mfa_required') setMfaStep(true);
    },
  });
  const credentials = (): LoginBody => ({
    email: email.trim(),
    password,
    ...(workspace ? { workspace } : {}),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(credentials());
  };
  if (mfaStep) {
    const stepError =
      login.error && !(isApiError(login.error, 401) && login.error.code === 'mfa_required')
        ? isApiError(login.error, 429)
          ? 'Too many attempts. Wait a minute, then try again.'
          : errorMessage(login.error)
        : null;
    return (
      <AuthLayout title="Two-factor authentication" subtitle="Enter the code from your authenticator app.">
        <MfaStep
          pending={login.isPending}
          error={stepError}
          onSubmit={(input: MfaLoginInput) => login.mutate({ ...credentials(), ...input })}
          onCancel={() => {
            login.reset();
            setPassword('');
            setMfaStep(false);
          }}
        />
      </AuthLayout>
    );
  }
  const failed = login.error
    ? isApiError(login.error, 401)
      ? 'That email and password do not match an account.'
      : isApiError(login.error, 429)
        ? 'Too many attempts. Wait a minute, then try again.'
        : errorMessage(login.error)
    : null;
  return (
    <AuthLayout
      title="Sign in"
      subtitle="Build and run the automations your workspace depends on."
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="font-semibold text-brand hover:underline">
            Create a workspace
          </Link>
        </>
      }
    >
      {/* P6-01 (L6): the workspace's SSO button, or a straight redirect to the identity provider */}
      <SsoSignIn workspace={workspace} redirect={safeRedirect(search.get('redirect'))} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {failed && <Callout tone="err">{failed}</Callout>}
        <FormField label="Email">
          {(id) => (
            <TextInput
              id={id}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-autofocus
            />
          )}
        </FormField>
        <FormField label="Password">
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </FormField>
        {/* P6-19 */}
        <Link
          to="/forgot-password"
          className="-mt-2 self-end text-sm font-semibold text-brand hover:underline"
        >
          Forgot password?
        </Link>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={login.isPending}
          disabled={!email || !password}
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const onSuccess = useAuthSuccess();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [touched, setTouched] = useState(false);
  const signup = useMutation({ mutationFn: authApi.signup, onSuccess });
  const problem = passwordProblem(form.password);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || !form.email || !form.name || !form.workspaceName) return;
    signup.mutate({
      ...form,
      email: form.email.trim(),
      name: form.name.trim(),
      workspaceName: form.workspaceName.trim(),
    });
  };
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="You will be its owner and can invite your team afterwards."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/signin" className="font-semibold text-brand hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {signup.error && (
          <Callout tone="err">
            {isApiError(signup.error, 409)
              ? 'An account with this email already exists. Sign in instead.'
              : errorMessage(signup.error)}
          </Callout>
        )}
        <FormField label="Your name" error={touched && !form.name ? 'Enter your name' : undefined}>
          {(id) => (
            <TextInput id={id} autoComplete="name" value={form.name} onChange={set('name')} data-autofocus />
          )}
        </FormField>
        <FormField label="Work email" error={touched && !form.email ? 'Enter your email' : undefined}>
          {(id) => (
            <TextInput id={id} type="email" autoComplete="email" value={form.email} onChange={set('email')} />
          )}
        </FormField>
        <FormField
          label="Password"
          hint="At least 8 characters, with a letter and a digit"
          error={touched ? problem : undefined}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              aria-invalid={Boolean(touched && problem) || undefined}
            />
          )}
        </FormField>
        <FormField
          label="Workspace name"
          hint="Usually your company or team"
          error={touched && !form.workspaceName ? 'Name the workspace' : undefined}
        >
          {(id) => (
            <TextInput
              id={id}
              autoComplete="organization"
              value={form.workspaceName}
              onChange={set('workspaceName')}
            />
          )}
        </FormField>
        <Button type="submit" variant="primary" size="lg" loading={signup.isPending}>
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}

export function AcceptInvitationPage() {
  const { token = '' } = useParams();
  const onSuccess = useAuthSuccess();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const accept = useMutation({
    mutationFn: (body: { name: string; password: string }) => authApi.acceptInvitation(token, body),
    onSuccess,
  });
  const problem = passwordProblem(password);
  return (
    <AuthLayout title="Join your team" subtitle="Set up your account to accept the invitation.">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!problem && name.trim()) accept.mutate({ name: name.trim(), password });
        }}
      >
        {accept.error && (
          <Callout tone="err">
            {isApiError(accept.error, 404) || isApiError(accept.error, 410)
              ? 'This invitation has expired or was already used. Ask for a new one.'
              : errorMessage(accept.error)}
          </Callout>
        )}
        <FormField label="Your name" error={touched && !name.trim() ? 'Enter your name' : undefined}>
          {(id) => (
            <TextInput
              id={id}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          )}
        </FormField>
        <FormField
          label="Password"
          hint="At least 8 characters, with a letter and a digit"
          error={touched ? problem : undefined}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" variant="primary" size="lg" loading={accept.isPending}>
          Accept invitation
        </Button>
      </form>
    </AuthLayout>
  );
}
