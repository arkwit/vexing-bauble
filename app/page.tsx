import { Card } from "@/types/card";

async function getCollection(): Promise<Card[]> {
  const response = await fetch(
    `${process.env.BACKEND_URL}/collection`,
    {
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error("Failed to retrieve collection");
  }

  return response.json();
}

export default async function Home() {
  const collection = await getCollection();

  return (
    <main>
      <h1>My Magic Collection</h1>

      <p>
        {collection.length} unique card identities
      </p>

      {collection.length === 0 ? (
        <p>Your collection is currently empty.</p>
      ) : (
        <div className="card-grid">
          {collection.flatMap((card) =>
            card.printings.map((printing) => (
              <div
                key={printing.id}
                className="card-item"
              >
                {printing.image_uri && (
                  <img
                    src={printing.image_uri}
                    alt={card.name}
                  />
                )}

                <h2>{card.name}</h2>

                <p>
                  Set: {printing.set_code.toUpperCase()}
                </p>

                <p>
                  Collector number:{" "}
                  {printing.collector_number}
                </p>

                <p>
                  Quantity: {printing.copies.length}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </main>
  );
}
