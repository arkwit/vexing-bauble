import Link from "next/link";

export default function CollectionLoading() {
  return (
    <main className="app-shell loading-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Vexing Bauble home">
          <span className="brand-mark">V</span>
          <span>VEXING BAUBLE</span>
        </Link>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">THE BINDER</p>
          <h1>Loading collection</h1>
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
