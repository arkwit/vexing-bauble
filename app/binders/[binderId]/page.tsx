import { Suspense } from "react";
import CollectionLoading from "../../collection-loading";
import CollectionWorkspace from "../../collection-workspace";

export default function BinderPage({
  params,
}: {
  params: Promise<{ binderId: string }>;
}) {
  return (
    <Suspense fallback={<CollectionLoading />}>
      <BinderWorkspace params={params} />
    </Suspense>
  );
}

async function BinderWorkspace({
  params,
}: {
  params: Promise<{ binderId: string }>;
}) {
  const { binderId } = await params;

  return (
    <CollectionWorkspace
      initialBinderView={`binder:${binderId}`}
      binderId={binderId}
    />
  );
}
