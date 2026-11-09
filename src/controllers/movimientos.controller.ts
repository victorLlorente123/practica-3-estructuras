import type { Request, Response } from "express";
import { ObjectId, type ClientSession, type Collection, type Filter } from "mongodb";
import { createSession } from "../config/database.js";
import { validarIBAN } from "./cuentas.controller.js";
import type { CuentaT } from "../models/cuentas.model.js";
import type { MovimientoT } from "../models/movimientos.model.js";

let movimientosCollection: Collection<MovimientoT>;
let cuentasCollection: Collection<CuentaT>;

export const configMovimientoCollection = (collection: Collection<MovimientoT>, cuentas: Collection<CuentaT>) => {
    movimientosCollection = collection;
    cuentasCollection = cuentas;
}

const getDatosOperacion = (req: Request, res: Response) => {
    if(!req.body || !Number.isSafeInteger(req.body.importe) || req.body.importe <= 0){
        res.status(400).json({ error: "El importe debe ser un entero positivo en céntimos dentro del rango seguro" });
        return;
    }

    if(typeof req.body.concepto !== "string" || !req.body.concepto.trim()){
        res.status(400).json({ error: "El concepto es obligatorio" });
        return;
    }

    if(req.body.categoria !== undefined && (typeof req.body.categoria !== "string" || !req.body.categoria.trim())){
        res.status(400).json({ error: "La categoría debe ser un texto no vacío" });
        return;
    }

    return {
        importe: Number(req.body.importe),
        concepto: String(req.body.concepto).trim(),
        categoria: String(req.body.categoria ?? "otros").trim()
    };
}

const getRetiradoHoy = (cuentaId: ObjectId, fecha: Date, session: ClientSession) => {
    const inicio = new Date(fecha);
    inicio.setHours(0, 0, 0, 0);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 1);

    return movimientosCollection.find({
        cuentaId,
        tipo: { $in: ["retirada", "transferencia_emitida"] },
        fecha: { $gte: inicio, $lt: fin }
    }, { session }).toArray().then((movimientos) => {
        let total = 0;

        for(const movimiento of movimientos){
            total -= movimiento.importe;
        }

        return total;
    });
}

const comprobarSalida = (cuenta: CuentaT, total: number, importe: number, fecha: Date, session: ClientSession) => {
    const saldoResultante = cuenta.saldo - total;

    if(!Number.isSafeInteger(total) || !Number.isSafeInteger(saldoResultante)){
        throw { status: 400, error: "El importe o el saldo resultante supera el rango de enteros seguros" };
    }

    if(saldoResultante < -cuenta.descubiertoMax){
        throw { status: 409, error: `Saldo insuficiente: disponible ${cuenta.saldo + cuenta.descubiertoMax} céntimos (incluido descubierto), solicitado ${total}` };
    }

    return getRetiradoHoy(cuenta._id!, fecha, session).then((retirado) => {
        if(retirado + importe > 100000){
            throw { status: 409, error: `Límite diario de 100000 céntimos superado: utilizado ${retirado}, solicitado ${importe}` };
        }

        return saldoResultante;
    });
}

const getFecha = (valor: string) => {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(valor)){
        return;
    }

    const fecha = new Date(valor + "T00:00:00");

    if(Number.isNaN(fecha.getTime()) || fecha.getFullYear() !== Number(valor.slice(0, 4)) ||
       fecha.getMonth() + 1 !== Number(valor.slice(5, 7)) || fecha.getDate() !== Number(valor.slice(8, 10))){
        return;
    }

    return fecha;
}

export const createIngreso = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID de la cuenta no es válido" });
        return;
    }

    const datos = getDatosOperacion(req, res);

    if(!datos){
        return;
    }

    const session = createSession();

    session.withTransaction(() => {
        return cuentasCollection.findOne({ _id: new ObjectId(id) }, { session }).then((cuenta) => {
            if(!cuenta){
                throw { status: 404, error: "Cuenta no encontrada" };
            }

            if(cuenta.estado === "cerrada"){
                throw { status: 409, error: "Una cuenta cerrada no admite ingresos" };
            }

            const saldoResultante = cuenta.saldo + datos.importe;

            if(!Number.isSafeInteger(saldoResultante)){
                throw { status: 400, error: "El saldo resultante supera el rango de enteros seguros" };
            }

            const movimiento: MovimientoT = {
                cuentaId: cuenta._id,
                tipo: "ingreso",
                importe: datos.importe,
                saldoResultante,
                concepto: datos.concepto,
                categoria: datos.categoria,
                fecha: new Date()
            };

            return cuentasCollection.updateOne({ _id: cuenta._id }, { $set: { saldo: saldoResultante } }, { session }).then(() => {
                return movimientosCollection.insertOne(movimiento, { session });
            }).then((result) => {
                return { ...movimiento, _id: result.insertedId };
            });
        });
    }).then((movimiento) => {
        res.status(201).json(movimiento);
    }).catch((error) => {
        res.status(error.status ?? 500).json({ error: error.error ?? "Error al realizar el ingreso" });
    }).finally(() => {
        return session.endSession();
    });
}

export const createRetirada = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID de la cuenta no es válido" });
        return;
    }

    const datos = getDatosOperacion(req, res);

    if(!datos){
        return;
    }

    const session = createSession();

    session.withTransaction(() => {
        return cuentasCollection.findOne({ _id: new ObjectId(id) }, { session }).then((cuenta) => {
            if(!cuenta){
                throw { status: 404, error: "Cuenta no encontrada" };
            }

            if(cuenta.estado !== "activa"){
                throw { status: 409, error: `La cuenta debe estar activa para retirar dinero (estado actual: ${cuenta.estado})` };
            }

            const fecha = new Date();

            return comprobarSalida(cuenta, datos.importe, datos.importe, fecha, session).then((saldoResultante) => {
                const movimiento: MovimientoT = {
                    cuentaId: cuenta._id,
                    tipo: "retirada",
                    importe: -datos.importe,
                    saldoResultante,
                    concepto: datos.concepto,
                    categoria: datos.categoria,
                    fecha
                };

                return cuentasCollection.updateOne({ _id: cuenta._id }, { $set: { saldo: saldoResultante } }, { session }).then(() => {
                    return movimientosCollection.insertOne(movimiento, { session });
                }).then((result) => {
                    return { ...movimiento, _id: result.insertedId };
                });
            });
        });
    }).then((movimiento) => {
        res.status(201).json(movimiento);
    }).catch((error) => {
        res.status(error.status ?? 500).json({ error: error.error ?? "Error al realizar la retirada" });
    }).finally(() => {
        return session.endSession();
    });
}

export const createTransferencia = (req: Request, res: Response) => {
    const datos = getDatosOperacion(req, res);

    if(!datos){
        return;
    }

    if(typeof req.body.ibanOrigen !== "string" || !validarIBAN(req.body.ibanOrigen.trim().toUpperCase())){
        res.status(400).json({ error: "El IBAN de origen no es válido" });
        return;
    }

    if(typeof req.body.ibanDestino !== "string" || !validarIBAN(req.body.ibanDestino.trim().toUpperCase())){
        res.status(400).json({ error: "El IBAN de destino no es válido" });
        return;
    }

    const ibanOrigen = req.body.ibanOrigen.trim().toUpperCase();
    const ibanDestino = req.body.ibanDestino.trim().toUpperCase();

    if(ibanOrigen === ibanDestino){
        res.status(400).json({ error: "Las cuentas de origen y destino deben ser distintas" });
        return;
    }

    const session = createSession();

    session.withTransaction(() => {
        return cuentasCollection.findOne({ iban: ibanOrigen }, { session }).then((origen) => {
            if(!origen){
                throw { status: 404, error: "Cuenta de origen no encontrada" };
            }

            return cuentasCollection.findOne({ iban: ibanDestino }, { session }).then((destino) => {
                if(!destino){
                    throw { status: 404, error: "Cuenta de destino no encontrada" };
                }

                if(origen.estado !== "activa"){
                    throw { status: 409, error: `La cuenta de origen debe estar activa (estado actual: ${origen.estado})` };
                }

                if(destino.estado === "cerrada"){
                    throw { status: 409, error: "La cuenta de destino está cerrada" };
                }

                const comision = origen.clienteId.equals(destino.clienteId) ? 0 : Math.max(100, Math.ceil(datos.importe / 200));
                const total = datos.importe + comision;
                const saldoDestino = destino.saldo + datos.importe;

                if(!Number.isSafeInteger(saldoDestino)){
                    throw { status: 400, error: "El saldo de destino supera el rango de enteros seguros" };
                }

                const fecha = new Date();

                return comprobarSalida(origen, total, datos.importe, fecha, session).then((saldoOrigen) => {
                    const transferenciaId = new ObjectId();
                    const movimientos: MovimientoT[] = [
                        {
                            cuentaId: origen._id,
                            tipo: "transferencia_emitida",
                            importe: -datos.importe,
                            saldoResultante: origen.saldo - datos.importe,
                            concepto: datos.concepto,
                            categoria: datos.categoria,
                            transferenciaId,
                            fecha
                        },
                        {
                            cuentaId: destino._id,
                            tipo: "transferencia_recibida",
                            importe: datos.importe,
                            saldoResultante: saldoDestino,
                            concepto: datos.concepto,
                            categoria: datos.categoria,
                            transferenciaId,
                            fecha
                        }
                    ];

                    if(comision > 0){
                        movimientos.push({
                            cuentaId: origen._id,
                            tipo: "comision",
                            importe: -comision,
                            saldoResultante: saldoOrigen,
                            concepto: datos.concepto,
                            categoria: datos.categoria,
                            transferenciaId,
                            fecha
                        });
                    }

                    return cuentasCollection.updateOne({ _id: origen._id }, { $set: { saldo: saldoOrigen } }, { session }).then(() => {
                        return cuentasCollection.updateOne({ _id: destino._id }, { $set: { saldo: saldoDestino } }, { session });
                    }).then(() => {
                        return movimientosCollection.insertMany(movimientos, { session });
                    }).then(() => {
                        return { transferenciaId, importe: datos.importe, comision, saldoOrigen, saldoDestino };
                    });
                });
            });
        });
    }).then((transferencia) => {
        res.status(201).json(transferencia);
    }).catch((error) => {
        res.status(error.status ?? 500).json({ error: error.error ?? "Error al realizar la transferencia" });
    }).finally(() => {
        return session.endSession();
    });
}

export const getMovimientos = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID de la cuenta no es válido" });
        return;
    }

    const paginaTexto = req.query.pagina ?? "1";
    const limiteTexto = req.query.limite ?? "20";

    if(typeof paginaTexto !== "string" || !/^\d+$/.test(paginaTexto) ||
       typeof limiteTexto !== "string" || !/^\d+$/.test(limiteTexto)){
        res.status(400).json({ error: "La página y el límite deben ser enteros positivos" });
        return;
    }

    const pagina = Number(paginaTexto);
    const limitePedido = Number(limiteTexto);
    const limite = Math.min(limitePedido, 100);
    const salto = (pagina - 1) * limite;

    if(!Number.isSafeInteger(pagina) || pagina < 1 || !Number.isSafeInteger(limitePedido) ||
       limitePedido < 1 || !Number.isSafeInteger(salto)){
        res.status(400).json({ error: "La página y el límite deben ser enteros positivos" });
        return;
    }

    const filtro: Filter<MovimientoT> = { cuentaId: new ObjectId(id) };
    const tiposValidos = ["ingreso", "retirada", "transferencia_emitida", "transferencia_recibida", "comision"];

    if(req.query.tipo !== undefined){
        if(typeof req.query.tipo !== "string"){
            res.status(400).json({ error: "El filtro de tipo no es válido" });
            return;
        }

        const tipos = req.query.tipo.split(",").map((tipo) => tipo.trim());

        if(tipos.some((tipo) => !tiposValidos.includes(tipo))){
            res.status(400).json({ error: "El filtro contiene un tipo de movimiento inexistente" });
            return;
        }

        filtro.tipo = { $in: tipos as MovimientoT["tipo"][] };
    }

    if(req.query.categoria !== undefined){
        if(typeof req.query.categoria !== "string" || !req.query.categoria.trim()){
            res.status(400).json({ error: "La categoría debe ser un texto no vacío" });
            return;
        }

        filtro.categoria = req.query.categoria.trim();
    }

    const orden = req.query.orden ?? "-fecha";

    if(orden !== "fecha" && orden !== "-fecha"){
        res.status(400).json({ error: "El orden debe ser fecha o -fecha" });
        return;
    }

    let desde: Date | undefined;
    let hasta: Date | undefined;

    if(req.query.desde !== undefined){
        desde = typeof req.query.desde === "string" ? getFecha(req.query.desde) : undefined;

        if(!desde){
            res.status(400).json({ error: "La fecha desde no es válida; utiliza AAAA-MM-DD" });
            return;
        }
    }

    if(req.query.hasta !== undefined){
        hasta = typeof req.query.hasta === "string" ? getFecha(req.query.hasta) : undefined;

        if(!hasta){
            res.status(400).json({ error: "La fecha hasta no es válida; utiliza AAAA-MM-DD" });
            return;
        }
    }

    if(desde && hasta && desde > hasta){
        res.status(400).json({ error: "La fecha desde no puede ser posterior a hasta" });
        return;
    }

    if(desde || hasta){
        const fechas: { $gte?: Date, $lt?: Date } = {};

        if(desde){
            fechas.$gte = desde;
        }

        if(hasta){
            const fin = new Date(hasta);
            fin.setDate(fin.getDate() + 1);
            fechas.$lt = fin;
        }

        filtro.fecha = fechas;
    }

    const sentido = orden === "fecha" ? 1 : -1;

    cuentasCollection.findOne({ _id: new ObjectId(id) }).then((cuenta) => {
        if(!cuenta){
            res.status(404).json({ error: "Cuenta no encontrada" });
            return;
        }

        return movimientosCollection.countDocuments(filtro).then((totalElementos) => {
            return movimientosCollection.find(filtro).sort({ fecha: sentido, _id: sentido }).skip(salto).limit(limite).toArray().then((datos) => {
                res.json({ datos, pagina, limite, totalElementos, totalPaginas: Math.ceil(totalElementos / limite) });
            });
        });
    }).catch(() => {
        res.status(500).json({ error: "Error al obtener los movimientos" });
    });
}
