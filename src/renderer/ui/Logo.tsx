/// <reference types="vite/client" />
import src from '../../../assets/logo.svg'

export const Logo = ({ size }: { size: number }) => <img src={src} width={size} height={size} alt="" draggable={false} />

/** Schriftzug neben dem Logo: „Pro“ leiser als Zusatz, ohne Deko */
export const Wordmark = () => <span>Deckwerk <span className="muted" style={{ fontWeight: 400 }}>Pro</span></span>
