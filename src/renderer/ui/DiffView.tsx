import React from 'react';

export function DiffView({ patches }: { patches: Array<{ added: boolean; removed: boolean; value: string }> }) {
  return (
    <pre style={{ flex: 1, overflow: 'auto', background: '#0b1020', color: '#e6e6e6', padding: 12, borderRadius: 8 }}>
      {patches.map((p, idx) => {
        const color = p.added ? '#a6ffb5' : p.removed ? '#ff9aa6' : '#e6e6e6';
        const prefix = p.added ? '+ ' : p.removed ? '- ' : '  ';
        return (
          <span key={idx} style={{ color }}>
            {p.value.split('\n').map((line, i, arr) => (
              <React.Fragment key={i}>
                {line.length ? prefix + line : ''}
                {i < arr.length - 1 ? '\n' : ''}
              </React.Fragment>
            ))}
          </span>
        );
      })}
    </pre>
  );
}
