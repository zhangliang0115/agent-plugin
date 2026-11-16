/**
 * The left-nav icon: three linked circles, the same mark as the MCP section
 * in the settings navigation. @module
 */
import type { ReactLike } from './types.ts';

/**
 * @param react - the React functions from the module loader.
 * @returns the icon component the settings navigation renders.
 */
export function createMcpIcon(react: ReactLike): (props: { size: number }) => unknown {
  const h = react.createElement;
  return function McpIcon(props: { size: number }): unknown {
    return h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: props.size,
        height: props.size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('circle', { cx: 6, cy: 12, r: 2.5 }),
      h('circle', { cx: 18, cy: 6, r: 2.5 }),
      h('circle', { cx: 18, cy: 18, r: 2.5 }),
      h('path', { d: 'M8.3 11l7.4-3.8M8.3 13l7.4 3.8' }),
    );
  };
}
