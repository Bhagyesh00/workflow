/** P6-19: `/confirm-email-change?token=`: confirms a new email (token in the POST body). */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

export function ConfirmEmailChangePage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // read once, then out of the address bar
  const [token] = useState(() => search.get('token') ?? '');
  useEffect(() => {
    if (search.has('token')) navigate('/confirm-email-change', { replace: true });
  }, [search, navigate]);
  const confirm = useMutation({ mutationFn: (value: string) => passwordApi.confirmEmailChange(value) });

  const footer = (
    <Link to="/signin" className="font-semibold text-brand hover:underline">
      Go to sign in
    </Link>
  );
  if (confirm.isSuccess) {
    return (
      <AuthLayout
        title="Email address changed"
        subtitle="Sign in with your new email address."
        footer={footer}
      >
        <Callout tone="ok">Your account now uses the new address.</Callout>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Confirm your new email"
      subtitle="Confirm that this is the address you want to sign in with."
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {token === '' && <Callout tone="err">The link is missing its token.</Callout>}
        {confirm.error && <Callout tone="err">{errorMessage(confirm.error)}</Callout>}
        <Button
          variant="primary"
          size="lg"
          loading={confirm.isPending}
          disabled={token === ''}
          onClick={() => confirm.mutate(token)}
        >
          Confirm new email
        </Button>
      </div>
    </AuthLayout>
  );
}
