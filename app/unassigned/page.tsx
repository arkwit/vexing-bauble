import { Suspense } from "react";
import CollectionLoading from "../collection-loading";
import CollectionWorkspace from "../collection-workspace";

export default function UnassignedPage() {
  return (
    <Suspense fallback={<CollectionLoading />}>
      <CollectionWorkspace initialBinderView="unassigned" />
    </Suspense>
  );
}
