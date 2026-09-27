export function Stamp({ voice, stamp }: { voice?: string; stamp?: string }) {
  const kind = voice === "creator" ? "creator" : "chronicle";
  return <span className={`stamp ${kind}`}>{stamp}</span>;
}
