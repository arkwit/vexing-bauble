import { notFound } from "next/navigation";
import { getBinders, getCollection } from "./actions";
import CollectionManager from "./collection-manager";

type CollectionWorkspaceProps = {
  initialBinderView: string;
  binderId?: string;
};

export default async function CollectionWorkspace({
  initialBinderView,
  binderId,
}: CollectionWorkspaceProps) {
  const [collection, binders] = await Promise.all([
    getCollection(),
    getBinders(),
  ]);

  if (
    binderId !== undefined &&
    (!/^\d+$/.test(binderId) ||
      !binders.some((binder) => binder.id === Number(binderId)))
  ) {
    notFound();
  }

  return (
    <CollectionManager
      key={initialBinderView}
      initialCollection={collection}
      initialBinders={binders}
      initialBinderView={initialBinderView}
    />
  );
}
