import type { ObjectId } from "mongodb";

export type MovimientoT = {
    _id?: ObjectId,
    cuentaId: ObjectId,
    tipo: "ingreso" | "retirada" | "transferencia_emitida" | "transferencia_recibida" | "comision",
    importe: number,
    saldoResultante: number,
    concepto: string,
    categoria: string,
    transferenciaId?: ObjectId,
    fecha: Date
}
