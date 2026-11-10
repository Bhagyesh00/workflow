/** P6-19: `/forgot-password`: asks for the email and mails a reset link (same answer for an unknown email). */
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

const BACK = (
  <Link to="/signin" className="font-semibold text-brand hover:underline">
    Back to sign in
  </Link>
);

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: (value: string) => passwordApi.forgot(value) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || send.isPending) return;
    send.mutate(email.trim());
  };
  const failed = send.error
    ? isApiError(send.error, 429)
      ? 'Too many attempts. Wait a minute, then try again.'
      : errorMessage(send.error)
    : null;
  if (send.isSuccess) {
    return (
      <AuthLayout title="Check your email" footer={BACK}>
        <Callout tone="ok">
          If an account uses {email.trim()}, a link to choose a new password is on its way. It works once, for
          20 minutes.
        </Callout>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="Enter your email and we will send you a link to choose a new one."
      footer={BACK}
    >
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
        <Button type="submit" variant="primary" size="lg" loading={send.isPending} disabled={!email.trim()}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
