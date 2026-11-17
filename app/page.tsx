import { Suspense } from "react";
import { getCollection } from "./actions";
import CollectionManager from "./collection-manager";

async function CollectionPage() {
  const collection = await getCollection();

  return <CollectionManager initialCollection={collection} />;
}

function CollectionLoading() {
  return (
    <main className="app-shell loading-shell" aria-label="Loading collection">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">V</span>
          <span>VEXING BAUBLE</span>
        </span>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">THE BINDER</p>
          <h1>Your collection,<br />beautifully gathered.</h1>
          <p className="hero-description">Gathering your cards...</p>
        </div>
      </section>
      <div className="loading-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="loading-card" key={index} />
        ))}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<CollectionLoading />}>
      <CollectionPage />
    </Suspense>
  );
}
