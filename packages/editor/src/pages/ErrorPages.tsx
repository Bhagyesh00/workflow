import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button } from '../components/ui/Button';

function Frame({
  code,
  title,
  description,
  action,
}: {
  code: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-start justify-center gap-4 px-10">
      <p className="font-display text-2xl font-bold text-ink-3">{code}</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="max-w-md text-base text-ink-2">{description}</p>
      <div className="flex gap-2">
        {action}
        <Link
          to="/workflows"
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-surface-2"
        >
          Go to workflows
        </Link>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <Frame
      code="404"
      title="This page does not exist"
      description="The link may be old, or the item was moved or deleted."
    />
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const message = error instanceof Error ? error.message : 'Something went wrong while showing this page.';
  return (
    <Frame
      code="Error"
      title="This page stopped working"
      description={message}
      action={
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      }
    />
  );
}
