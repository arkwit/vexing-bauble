import { Suspense } from "react";
import CollectionWorkspace from "./collection-workspace";
import CollectionLoading from "./collection-loading";

export default function Home() {
  return (
    <Suspense fallback={<CollectionLoading />}>
      <CollectionWorkspace initialBinderView="dashboard" />
    </Suspense>
  );
}
