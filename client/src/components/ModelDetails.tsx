import type { Asset } from '../types';
import { formatCompactCount, formatModelSize } from '../lib/modelFormat';

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex justify-between gap-2 py-1 border-b border-[#202033]">
      <span className="text-slate-400 select-text shrink-0">{label}</span>
      <span className="font-mono text-slate-200 select-text truncate" title={title ?? value}>{value}</span>
    </div>
  );
}

/** Inspector metadata rows for a glTF model. */
export function ModelDetails({ asset }: { asset: Asset }) {
  const metadata = asset.metadata;
  const count = (value?: number) => (value === undefined ? null : value.toLocaleString());
  const size = formatModelSize(metadata.modelBounds);
  const required = metadata.gltfExtensionsRequired ?? [];
  const used = (metadata.gltfExtensionsUsed ?? []).filter((name) => !required.includes(name));
  const rows: { label: string; value: string | null; title?: string }[] = [
    {
      label: 'Triangles',
      value: metadata.triangleCount === undefined ? null : formatCompactCount(metadata.triangleCount),
      title: count(metadata.triangleCount) ?? undefined,
    },
    { label: 'Vertices', value: count(metadata.vertexCount) },
    {
      label: 'Meshes',
      value: metadata.meshCount === undefined ? null
        : `${metadata.meshCount.toLocaleString()} (${(metadata.primitiveCount ?? 0).toLocaleString()} primitives)`,
    },
    { label: 'Materials', value: count(metadata.materialCount) },
    { label: 'Textures', value: count(metadata.textureCount) },
    { label: 'Animations', value: count(metadata.animationCount) },
    { label: 'Skins', value: metadata.skinCount ? count(metadata.skinCount) : null },
    { label: 'Size (X × Y × Z)', value: size },
    { label: 'Generator', value: metadata.generator ?? null },
    { label: 'Required extensions', value: required.length ? required.join(', ') : null },
    { label: 'Extensions', value: used.length ? used.join(', ') : null },
  ];
  const problem = metadata.modelMetadataStatus === 'failed'
    ? `Model could not be read: ${metadata.modelMetadataError ?? 'unknown error'}`
    : metadata.modelThumbnailIssue
      ? `Thumbnail ${metadata.modelThumbnailStatus === 'partial' ? 'is partial' : 'uses a placeholder'}: ${metadata.modelThumbnailIssue}`
      : null;

  return (
    <>
      {rows.map((row) => row.value !== null && (
        <Row key={row.label} label={row.label} value={row.value} title={row.title} />
      ))}
      {problem && (
        <p role="note" className="py-1.5 text-[11px] text-amber-300/90 border-b border-[#202033] select-text">
          {problem}
        </p>
      )}
    </>
  );
}
