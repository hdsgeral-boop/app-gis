import { ListaDeRegistos } from '@/ecras/ListaDeRegistos';

/** Ver `src/ecras/ListaDeRegistos.tsx`: os três ecrãs são o mesmo com outro filtro. */
export default function Ecra() {
  return <ListaDeRegistos filtro="por_enviar" />;
}
