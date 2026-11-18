/** Distingue desligado de ausência de informação; nunca presume que a IA foi desativada. */
export function estadoIaNoChip(valor: unknown): boolean | null {
 if(!valor||typeof valor!=='object')return null;
 const estado=(valor as Record<string,unknown>).chip_enabled;
 return typeof estado==='boolean'?estado:null;
}
