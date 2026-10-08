/**
 * The seal of the Municipality of Candoni. Patch 115.
 *
 * It took the place of the blue "CFMS" square in the menu and on the sign-in
 * page. The image is the municipality's own seal with the white square around
 * the outer ring cut away, so it sits on the dark menu as a circle rather
 * than as a white tile. Kept in /public so it is fetched once and cached, not
 * built into the application's code.
 */
export function Seal({ className }: { className?: string }) {
  return (
    <img
      src="/candoni-seal.png"
      alt="Seal of the Municipality of Candoni, Negros Occidental"
      className={className}
      draggable={false}
    />
  );
}
