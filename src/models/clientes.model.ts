import type { ObjectId } from "mongodb";

export type ClienteT = {
    _id?: ObjectId,
    nombre: string,
    email: string,
    dni: string,
    creadoEn: Date
}
