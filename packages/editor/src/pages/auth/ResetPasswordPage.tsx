/**
 * P6-19: `/reset-password?token=`: reads the token once, moves it out of the address bar and sends it in
 * the POST body; asks for an MFA code when the account has MFA on.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';
import { passwordProblem } from './AuthPages';

export function ResetPasswordPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // the token is read once into state; the address no longer holds it after the first render
  const [token] = useState(() => search.get('token') ?? '');
  useEffect(() => {
    if (search.has('token')) navigate('/reset-password', { replace: true });
  }, [search, navigate]);

  const info = useQuery({
    queryKey: ['reset-token', token],
    queryFn: () => passwordApi.resolveResetToken(token),
    enabled: token !== '',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [touched, setTouched] = useState(false);
  const reset = useMutation({ mutationFn: passwordApi.reset });

  const back = (
    <Link to="/signin" className="font-semibold text-brand hover:underline">
      Back to sign in
    </Link>
  );

  if (reset.isSuccess) {
    return (
      <AuthLayout title="Password changed" subtitle="Sign in with your new password." footer={back}>
        <Callout tone="ok">Every session of this account was signed out.</Callout>
      </AuthLayout>
    );
  }
  if (token === '' || info.isError) {
    return (
      <AuthLayout title="This link does not work" footer={back}>
        <Callout tone="err">
          {token === '' ? 'The link is missing its token.' : errorMessage(info.error)}{' '}
          <Link to="/forgot-password" className="font-semibold text-brand hover:underline">
            Ask for a new link
          </Link>
        </Callout>
      </AuthLayout>
    );
  }
  if (!info.data) {
    return (
      <AuthLayout title="Choose a new password">
        <PageLoader label="Checking your link" />
      </AuthLayout>
    );
  }
  const mfaAsked = info.data.mfaEnabled;
  const problem = passwordProblem(password);
  const mismatch = again !== '' && again !== password ? 'The passwords do not match' : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || password !== again || (mfaAsked && !mfaCode.trim()) || reset.isPending) return;
    reset.mutate({ token, password, ...(mfaAsked ? { mfaCode: mfaCode.trim() } : {}) });
  };
  return (
    <AuthLayout title="Choose a new password" footer={back}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {reset.error && <Callout tone="err">{errorMessage(reset.error)}</Callout>}
        <FormField
          label="New password"
          hint="At least 8 characters, with a letter and a digit."
          error={touched ? problem : null}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-autofocus
            />
          )}
        </FormField>
        <FormField label="Repeat the new password" error={mismatch}>
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          )}
        </FormField>
        {mfaAsked && (
          <FormField
            label="Authentication code"
            hint="The 6 digit code from your authenticator app, or a recovery code."
          >
            {(id) => (
              <TextInput
                id={id}
                autoComplete="one-time-code"
                spellCheck={false}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            )}
          </FormField>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={reset.isPending}
          disabled={!password || !again}
        >
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
