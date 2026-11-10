/**
 * P6-13: `/saml/onboarding`: asks for the name a SAML sign-in did not carry. The person is already signed in
 * (the server set the session before sending them here); a signed-out visitor goes to the sign-in page, and a
 * person who has a name goes straight to the app.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { queryKeys, useMe } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { AuthLayout } from '../auth/AuthLayout';

export function SamlOnboardingPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const save = useMutation({
    mutationFn: () => passwordApi.updateProfile({ name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate('/', { replace: true });
    },
  });

  if (me.isLoading) return <PageLoader />;
  if (isApiError(me.error, 401) || (!me.data && !me.error)) return <Navigate to="/signin" replace />;
  if (me.error) return <Callout tone="err">{errorMessage(me.error)}</Callout>;
  if (me.data?.user.name?.trim()) return <Navigate to="/" replace />;

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
      </form>
    </AuthLayout>
  );
}
