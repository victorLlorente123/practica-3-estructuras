import type { ObjectId } from "mongodb";

export type CuentaT = {
    _id?: ObjectId,
    iban: string,
    clienteId: ObjectId,
    tipo: "corriente" | "ahorro",
    saldo: number,
    descubiertoMax: number,
    estado: "activa" | "bloqueada" | "cerrada",
    creadaEn: Date
}
