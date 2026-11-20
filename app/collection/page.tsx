import { Suspense } from "react";
import CollectionLoading from "../collection-loading";
import CollectionWorkspace from "../collection-workspace";

export default function CollectionPage() {
  return (
    <Suspense fallback={<CollectionLoading />}>
      <CollectionWorkspace initialBinderView="all" />
    </Suspense>
  );
}
