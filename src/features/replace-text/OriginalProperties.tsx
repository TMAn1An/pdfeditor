export interface OriginalInfoView {
  fontName: string;
  embedded: number;
  subset: boolean;
  standardFont: boolean;
  effectiveSize: number;
  color: string;
  rotation: number;
  matrix: readonly number[];
  bounds: readonly number[];
  availableChars: string;
  renderMode?: number;
}

/** Detected properties of existing PDF text. */
export function OriginalProperties({ info }: { info: OriginalInfoView }) {
  const [l, b, r, t] = info.bounds;
  return (
    <>
      <dl className="kv">
        <dt>Font</dt>
        <dd>{info.fontName}</dd>
        <dt>Embedded</dt>
        <dd>
          {info.standardFont
            ? 'No — standard PDF font (viewers provide it)'
            : info.embedded === 1
              ? info.subset
                ? 'Yes, subset'
                : 'Yes'
              : info.embedded === 0
                ? 'No'
                : 'Unknown'}
        </dd>
        <dt>Size</dt>
        <dd>{info.effectiveSize.toFixed(1)} pt</dd>
        <dt>Colour</dt>
        <dd>
          <span className="swatch" style={{ background: info.color }} aria-hidden /> {info.color}
        </dd>
        <dt>Position</dt>
        <dd>
          baseline at x {info.matrix[4]!.toFixed(1)}, y {info.matrix[5]!.toFixed(1)} pt
        </dd>
        <dt>Rotation</dt>
        <dd>{Math.abs(info.rotation) < 0.05 ? 'none' : `${info.rotation.toFixed(1)}°`}</dd>
        <dt>Bounds</dt>
        <dd>
          {(r! - l!).toFixed(1)} × {(t! - b!).toFixed(1)} pt
        </dd>
      </dl>
      {info.availableChars && (
        <details className="small">
          <summary>Characters the original font can draw ({Array.from(info.availableChars).length})</summary>
          <p className="mono chars">{info.availableChars}</p>
        </details>
      )}
    </>
  );
}
