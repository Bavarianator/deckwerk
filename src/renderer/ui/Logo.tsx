/// <reference types="vite/client" />
import src from '../../../assets/logo.svg'

export const Logo = ({ size }: { size: number }) => <img src={src} width={size} height={size} alt="" draggable={false} />
