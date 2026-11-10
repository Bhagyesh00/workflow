/**
 * P6-13: `/saml/onboarding`: asks for the name a SAML sign-in did not carry. The person is already signed in
 * (the server set the session before sending them here, and gave a new person the email's first part as a
 * stand-in name, so the page cannot tell by the name: the redirect itself is the signal). A signed-out visitor
 * goes to the sign-in page and a session that is not a SAML one goes to the app. The page the person came for
 * arrives as `?next=` (the sign-in's RelayState, a same-app path) and is where Continue and Skip go.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { queryKeys, useMe } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { AuthLayout } from '../auth/AuthLayout';
import { safeRedirect } from '../auth/AuthPages';

export function SamlOnboardingPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search] = useSearchParams();
  const next = safeRedirect(search.get('next'));
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => passwordApi.updateProfile({ name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate(next, { replace: true });
    },
  });

  if (me.isLoading) return <PageLoader />;
  if (isApiError(me.error, 401) || (!me.data && !me.error)) return <Navigate to="/signin" replace />;
  if (me.error) return <Callout tone="err">{errorMessage(me.error)}</Callout>;
  // an older server names no method; any other method than SAML has nothing to ask
  if (me.data?.authMethod && me.data.authMethod !== 'saml') return <Navigate to={next} replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <AuthLayout
      title="Add your name"
      subtitle="Your identity provider did not send one. Teammates will see it next to your work."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Your name" required>
          {(id) => (
            <TextInput
              id={id}
              autoFocus
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        {save.error && <Callout tone="err">{errorMessage(save.error)}</Callout>}
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
          Continue
        </Button>
        <Link to={next} replace className="text-center text-sm font-semibold text-ink-2 hover:text-ink">
          Skip for now
        </Link>
      </form>
    </AuthLayout>
  );
}
