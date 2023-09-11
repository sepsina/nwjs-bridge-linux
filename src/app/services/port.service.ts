///<reference types="chrome"/>
import {Injectable} from '@angular/core';
import {EventsService} from './events.service';
import {UtilsService} from './utils.service';
import * as gConst from '../gConst';
import * as gIF from '../gIF';

@Injectable({
    providedIn: 'root',
})
export class PortService {

    private searchPortFlag = false;
    private validPortFlag = false;
    private portOpenFlag = false;
    private portIdx = 0;

    private testPortTMO = null;

    private crc: number;
    private calcCRC: number;
    private msgIdx: number;
    private isEsc = false;
    private rxBuf = new ArrayBuffer(1024);
    private rxMsg = new Uint8Array(this.rxBuf);
    private rxState: gIF.eRxState = gIF.eRxState.E_STATE_RX_WAIT_START;

    private msgType: number;
    private msgLen: number;

    private seqNum = 0;

    private hostCmdQueue: gIF.hostCmd_t[] = [];
    private hostCmdFlag = false;
    private hostCmdTmoRef;
    private runTmoRef = null;

    private tmoFlag = false;
    private comFlag = false;

    private comPorts = [];
    private connID = -1;

    //private listPortsFlag = false;

    constructor(private events: EventsService,
                private utils: UtilsService) {
        this.events.subscribe('wr_bind', (bind)=>{
            this.wrBind(bind);
        });
        this.events.subscribe('zcl_cmd', (cmd)=>{
            this.udpZclCmd(cmd);
        });
        chrome.serial.onReceive.addListener((info)=>{
            if(info.connectionId === this.connID){
                this.slOnData(info.data);
            }
        });
        chrome.serial.onReceiveError.addListener((info: any)=>{
                this.rcvErrCB(info);
        });
        setTimeout(()=>{
            this.checkCom();
        }, 15000);
        setTimeout(()=>{
            this.listComPorts();
        }, 1000);
    }

    /***********************************************************************************************
     * fn          checkCom
     *
     * brief
     *
     */
    checkCom() {
        if(this.comFlag == false) {
            this.hostCmdQueue = [];
            this.hostCmdFlag = false;
            if(this.validPortFlag === true){
                setTimeout(()=>{
                    this.closeComPort();
                }, 0);
            }
        }
        this.comFlag = false;
        setTimeout(()=>{
            this.checkCom();
        }, 30000);
    }

    /***********************************************************************************************
     * fn          closeComPort
     *
     * brief
     *
     */
    closeComPort() {
        if(this.connID > -1){
            this.utils.sendMsg('close port', 'red');
            chrome.serial.disconnect(
                this.connID,
                (result)=>{
                    this.connID = -1;
                    this.portOpenFlag = false;
                    this.validPortFlag = false;
                    setTimeout(() => {
                        this.findComPort();
                    }, 200);
                }
            );
        }
    }

    /***********************************************************************************************
     * fn          listComPorts
     *
     * brief
     *
     */
    listComPorts() {
        chrome.serial.getDevices((ports)=>{
            this.comPorts = [];
            for(let i = 0; i < ports.length; i++){
                if(ports[i].vendorId === 0x0403){      // FTDI
                    //if(ports[i].productId === 0x6015){ // FX230
                    if(ports[i].productId === 0x6001){   // FT232RL
                        this.comPorts.push(ports[i]);
                    }
                }
            }
            if(this.comPorts.length) {
                this.searchPortFlag = true;
                this.portIdx = 0;
                setTimeout(()=>{
                    this.findComPort();
                }, 200);
            }
            else {
                this.searchPortFlag = false;
                setTimeout(()=>{
                    this.listComPorts();
                }, 2000);
                this.utils.sendMsg('no com ports', 'red', 7);
            }
        });
    }

    /***********************************************************************************************
     * fn          findComPort
     *
     * brief
     *
     */
    private findComPort() {

        if(this.searchPortFlag === false){
            setTimeout(()=>{
                this.listComPorts();
            }, 1000);
            return;
        }
        let portPath = this.comPorts[this.portIdx].path;
        this.utils.sendMsg(`testing: ${portPath}`, 'blue');
        let connOpts = {
            bitrate: 115200
        };
        chrome.serial.connect(
            portPath,
            connOpts,
            (connInfo)=>{
                if(connInfo){
                    this.connID = connInfo.connectionId;
                    this.portOpenFlag = true;
                    this.testPortTMO = setTimeout(()=>{
                        this.closeComPort();
                    }, 2000);
                    this.testPortReq();
                }
                else {
                    this.utils.sendMsg(`err: ${chrome.runtime.lastError.message}`, 'red');
                    setTimeout(() => {
                        this.findComPort();
                    }, 200);
                }
            }
        );
        this.portIdx++;
        if(this.portIdx >= this.comPorts.length) {
            this.searchPortFlag = false;
        }
    }

    /***********************************************************************************************
     * fn          slOnData
     *
     * brief
     *
     */
    private slOnData(msg) {

        let pkt = new Uint8Array(msg);

        for(let i = 0; i < pkt.length; i++) {
            let rxByte = pkt[i];
            switch(rxByte) {
                case gConst.SL_START_CHAR: {
                    this.msgIdx = 0;
                    this.isEsc = false;
                    this.rxState = gIF.eRxState.E_STATE_RX_WAIT_TYPELSB;
                    break;
                }
                case gConst.SL_ESC_CHAR: {
                    this.isEsc = true;
                    break;
                }
                case gConst.SL_END_CHAR: {
                    if(this.crc == this.calcCRC) {
                        let slMsg: gIF.slMsg_t = {
                            type: this.msgType,
                            data: Array.from(this.rxMsg).slice(0, this.msgIdx),
                        };
                        setTimeout(()=>{
                            this.processMsg(slMsg);
                        }, 0);
                    }
                    this.rxState = gIF.eRxState.E_STATE_RX_WAIT_START;
                    break;
                }
                default: {
                    if (this.isEsc == true) {
                        rxByte ^= 0x10;
                        this.isEsc = false;
                    }
                    switch(this.rxState) {
                        case gIF.eRxState.E_STATE_RX_WAIT_START: {
                            // ---
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_TYPELSB: {
                            this.msgType = rxByte;
                            this.rxState = gIF.eRxState.E_STATE_RX_WAIT_TYPEMSB;
                            this.calcCRC = rxByte;
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_TYPEMSB: {
                            this.msgType += rxByte << 8;
                            this.rxState = gIF.eRxState.E_STATE_RX_WAIT_LENLSB;
                            this.calcCRC ^= rxByte;
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_LENLSB: {
                            this.msgLen = rxByte;
                            this.rxState = gIF.eRxState.E_STATE_RX_WAIT_LENMSB;
                            this.calcCRC ^= rxByte;
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_LENMSB: {
                            this.msgLen += rxByte << 8;
                            this.rxState = gIF.eRxState.E_STATE_RX_WAIT_CRC;
                            this.calcCRC ^= rxByte;
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_CRC: {
                            this.crc = rxByte;
                            this.rxState = gIF.eRxState.E_STATE_RX_WAIT_DATA;
                            break;
                        }
                        case gIF.eRxState.E_STATE_RX_WAIT_DATA: {
                            if(this.msgIdx < this.msgLen) {
                                this.rxMsg[this.msgIdx++] = rxByte;
                                this.calcCRC ^= rxByte;
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    /***********************************************************************************************
     * fn          processMsg
     *
     * brief
     *
     */
    private processMsg(msg: gIF.slMsg_t) {

        this.comFlag = true;

        let msgData = new Uint8Array(msg.data);
        switch(msg.type) {
            case gConst.SL_MSG_TESTPORT: {
                let msgView = new DataView(msgData.buffer);
                let idNum: number;
                let msgIdx = 0;
                let msgSeqNum = msgView.getUint8(msgIdx++);
                if (msgSeqNum == this.seqNum) {
                    idNum = msgView.getUint32(msgIdx, gConst.LE);
                    msgIdx += 4;
                    if(idNum === 0x67190110) {
                        clearTimeout(this.testPortTMO);
                        this.validPortFlag = true;
                        this.searchPortFlag = false;
                        this.utils.sendMsg('port valid', 'green');
                    }
                }
                break;
            }
            case gConst.SL_MSG_HOST_ANNCE: {
                let dataHost = {} as gIF.dataHost_t;
                let msgView = new DataView(msgData.buffer);
                let idx = 0;
                dataHost.shortAddr = msgView.getUint16(idx, gConst.LE);
                idx += 2;
                dataHost.extAddr = msgView.getFloat64(idx, gConst.LE);
                idx += 8;
                dataHost.numAttrSets = msgView.getInt8(idx++);
                dataHost.numSrcBinds = msgView.getInt8(idx++);
                let ttl = msgView.getUint16(idx, gConst.LE);

                //let log = this.utils.timeStamp();
                let log = 'host ->';
                log += ` short: 0x${dataHost.shortAddr.toString(16).padStart(4, '0').toUpperCase()},`;
                log += ` ext: ${this.utils.extToHex(dataHost.extAddr)},`;
                log += ` numAttr: ${dataHost.numAttrSets},`;
                log += ` numBinds: ${dataHost.numSrcBinds}`;
                this.utils.sendMsg(log);

                if(this.hostCmdQueue.length > 15) {
                    this.hostCmdQueue = [];
                    this.hostCmdFlag = false;
                }
                if(dataHost.numAttrSets > 0) {
                    let cmd: gIF.hostCmd_t = {
                        shortAddr: dataHost.shortAddr,
                        type: gConst.RD_ATTR,
                        idx: 0,
                        retryCnt: gConst.RD_HOST_RETRY_CNT,
                        param: '',
                    };
                    this.hostCmdQueue.push(cmd);
                }
                if(dataHost.numSrcBinds > 0) {
                    let cmd: gIF.hostCmd_t = {
                        shortAddr: dataHost.shortAddr,
                        type: gConst.RD_BIND,
                        idx: 0,
                        retryCnt: gConst.RD_HOST_RETRY_CNT,
                        param: '',
                    };
                    this.hostCmdQueue.push(cmd);
                }
                if(this.hostCmdQueue.length > 0) {
                    if(this.hostCmdFlag === false) {
                        this.hostCmdFlag = true;
                        this.runHostCmd();
                    }
                    if(this.runTmoRef === null) {
                        this.runTmoRef = setTimeout(()=>{
                            this.runTmoRef = null;
                            this.hostCmdFlag = true;
                            this.runHostCmd();
                        }, 3000);
                    }
                }
                break;
            }
            case gConst.SL_MSG_LOG: {
                let idx = msgData.indexOf(10);
                if(idx > -1) {
                    msgData[idx] = 32;
                }
                this.utils.sendMsg(String.fromCharCode.apply(null, msgData));
                break;
            }
            case gConst.SL_MSG_READ_ATTR_SET_AT_IDX: {
                let rxSet = {} as gIF.attrSet_t;
                let msgView = new DataView(msgData.buffer);
                let msgIdx = 0;
                let msgSeqNum = msgView.getUint8(msgIdx++);
                if(msgSeqNum == this.seqNum) {
                    rxSet.hostShortAddr = this.hostCmdQueue[0].shortAddr;
                    let status = msgView.getUint8(msgIdx++);
                    if(status == gConst.SL_CMD_OK) {
                        let memIdx = msgView.getUint8(msgIdx++);
                        rxSet.partNum = msgView.getUint32(msgIdx, gConst.LE);
                        msgIdx += 4;
                        rxSet.clusterServer = msgView.getUint8(msgIdx++);
                        rxSet.extAddr = msgView.getFloat64(msgIdx, gConst.LE);
                        msgIdx += 8;
                        rxSet.shortAddr = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxSet.endPoint = msgView.getUint8(msgIdx++);
                        rxSet.clusterID = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxSet.attrSetID = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxSet.attrMap = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxSet.valsLen = msgView.getUint8(msgIdx++);
                        rxSet.attrVals = [];
                        for(let i = 0; i < rxSet.valsLen; i++) {
                            rxSet.attrVals[i] = msgView.getUint8(msgIdx++);
                        }

                        this.events.publish('attr_set', JSON.stringify(rxSet));

                        let cmd = this.hostCmdQueue.shift();
                        cmd.idx = memIdx + 1;
                        cmd.retryCnt = gConst.RD_HOST_RETRY_CNT;
                        this.hostCmdQueue.push(cmd);
                        this.runHostCmd();
                    }
                    else {
                        this.hostCmdQueue.shift();
                        if(this.hostCmdQueue.length > 0) {
                            this.runHostCmd();
                        }
                        else {
                            this.seqNum = ++this.seqNum % 256;
                            clearTimeout(this.hostCmdTmoRef);
                            this.hostCmdFlag = false;
                        }
                    }
                }
                break;
            }
            case gConst.SL_MSG_READ_BIND_AT_IDX: {
                let rxBind = {} as gIF.clusterBind_t;
                let msgView = new DataView(msgData.buffer);
                let msgIdx = 0;
                let msgSeqNum = msgView.getUint8(msgIdx++);
                if(msgSeqNum == this.seqNum) {
                    rxBind.hostShortAddr = this.hostCmdQueue[0].shortAddr;
                    let status = msgView.getUint8(msgIdx++);
                    if(status == gConst.SL_CMD_OK) {
                        let memIdx = msgView.getUint8(msgIdx++);
                        rxBind.partNum = msgView.getUint32(msgIdx, gConst.LE);
                        msgIdx += 4;
                        rxBind.extAddr = msgView.getFloat64(msgIdx, gConst.LE);
                        msgIdx += 8;
                        rxBind.srcShortAddr = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxBind.srcEP = msgView.getUint8(msgIdx++);
                        rxBind.clusterID = msgView.getUint16(msgIdx, gConst.LE);
                        msgIdx += 2;
                        rxBind.dstExtAddr = msgView.getFloat64(msgIdx, gConst.LE);
                        msgIdx += 8;
                        rxBind.dstEP = msgView.getUint8(msgIdx++);

                        this.events.publish('cluster_bind', JSON.stringify(rxBind));

                        let cmd = this.hostCmdQueue.shift();
                        cmd.idx = memIdx + 1;
                        cmd.retryCnt = gConst.RD_HOST_RETRY_CNT;
                        this.hostCmdQueue.push(cmd);
                        this.runHostCmd();
                    }
                    else {
                        this.hostCmdQueue.shift();
                        if(this.hostCmdQueue.length > 0) {
                            this.runHostCmd();
                        }
                        else {
                            this.seqNum = ++this.seqNum % 256;
                            clearTimeout(this.hostCmdTmoRef);
                            this.hostCmdFlag = false;
                        }
                    }
                }
                break;
            }
            case gConst.SL_MSG_WRITE_BIND: {
                let msgView = new DataView(msgData.buffer);
                let msgIdx = 0;
                let msgSeqNum = msgView.getUint8(msgIdx++);
                if(msgSeqNum == this.seqNum) {
                    let status = msgView.getUint8(msgIdx++);
                    if(status == gConst.SL_CMD_OK) {
                        this.utils.sendMsg('wr binds status: OK');
                    }
                    else {
                        this.utils.sendMsg('wr binds status: FAIL');
                    }
                    this.hostCmdQueue.shift();
                    if(this.hostCmdQueue.length > 0) {
                        this.runHostCmd();
                    }
                    else {
                        this.seqNum = ++this.seqNum % 256;
                        clearTimeout(this.hostCmdTmoRef);
                        this.hostCmdFlag = false;
                    }
                }
                break;
            }
            case gConst.SL_MSG_ZCL_CMD: {
                let msgView = new DataView(msgData.buffer);
                let msgIdx = 0;
                let msgSeqNum = msgView.getUint8(msgIdx++);
                if(msgSeqNum == this.seqNum) {
                    // ---
                    this.hostCmdQueue.shift();
                    if(this.hostCmdQueue.length > 0) {
                        this.runHostCmd();
                    }
                    else {
                        this.seqNum = ++this.seqNum % 256;
                        clearTimeout(this.hostCmdTmoRef);
                        this.hostCmdFlag = false;
                    }
                }
                break;
            }
            default: {
                console.log('unsupported sl command!');
                break;
            }
        }
    }

    /***********************************************************************************************
     * fn          runHostCmd
     *
     * brief
     *
     */
    private runHostCmd() {

        clearTimeout(this.hostCmdTmoRef);

        if(this.runTmoRef) {
            clearTimeout(this.runTmoRef);
            this.runTmoRef = null;
        }
        this.tmoFlag = true;
        let hostCmd = this.hostCmdQueue[0];
        if(hostCmd) {
            switch(hostCmd.type) {
                case gConst.RD_ATTR: {
                    this.reqAttrAtIdx();
                    break;
                }
                case gConst.RD_BIND: {
                    this.reqBindAtIdx();
                    break;
                }
                case gConst.WR_BIND: {
                    this.wrBindReq();
                    break;
                }
                case gConst.ZCL_CMD: {
                    this.zclReq();
                    break;
                }
                default: {
                    this.tmoFlag = false;
                    break;
                }
            }
        }
        this.hostCmdTmoRef = setTimeout(()=>{
            this.hostCmdTmo();
        }, gConst.RD_HOST_TMO);
    }

    /***********************************************************************************************
     * fn          hostCmdTmo
     *
     * brief
     *
     */
    private hostCmdTmo() {

        this.utils.sendMsg('--- READ_HOST_TMO ---', 'red');

        if(this.hostCmdQueue.length === 0) {
            this.hostCmdFlag = false;
            return;
        }

        let hostCmd = this.hostCmdQueue.shift();
        if(hostCmd.retryCnt) {
            hostCmd.retryCnt--;
            this.hostCmdQueue.push(hostCmd);
        }
        if(this.hostCmdQueue.length == 0) {
            this.hostCmdFlag = false;
            return;
        }
        this.tmoFlag = true;
        let cmd = this.hostCmdQueue[0];
        switch (cmd.type) {
            case gConst.RD_ATTR: {
                this.reqAttrAtIdx();
                break;
            }
            case gConst.RD_BIND: {
                this.reqBindAtIdx();
                break;
            }
            case gConst.WR_BIND: {
                this.wrBindReq();
                break;
            }
            case gConst.ZCL_CMD: {
                this.zclReq();
                break;
            }
            default: {
                this.tmoFlag = false;
                break;
            }
        }
        this.hostCmdTmoRef = setTimeout(()=>{
            this.hostCmdTmo();
        }, gConst.RD_HOST_TMO);
    }

    /***********************************************************************************************
     * fn          testPortReq
     *
     * brief
     *
     */
    private testPortReq() {

        let pktBuf = new ArrayBuffer(64);
        let pktData = new Uint8Array(pktBuf);
        let pktView = new DataView(pktBuf);
        let slMsgBuf = new Uint8Array(128);
        let i: number;
        let msgIdx: number;

        this.seqNum = ++this.seqNum % 256;
        msgIdx = 0;
        pktView.setUint16(msgIdx, gConst.SL_MSG_TESTPORT, gConst.LE);
        msgIdx += 2;
        msgIdx += 2 + 1; // len + crc
        // cmd data
        pktView.setUint8(msgIdx++, this.seqNum);
        pktView.setUint32(msgIdx, 0x67190110, gConst.LE);
        msgIdx += 4;
        let msgLen = msgIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        pktView.setUint16(gConst.LEN_IDX, dataLen, gConst.LE);
        let crc = 0;
        for(i = 0; i < msgLen; i++) {
            crc ^= pktData[i];
        }
        pktView.setUint8(gConst.CRC_IDX, crc);

        this.serialSend(pktData, msgLen);
    }

    /***********************************************************************************************
     * fn          reqAttrAtIdx
     *
     * brief
     *
     */
    private reqAttrAtIdx() {

        let hostCmd = this.hostCmdQueue[0];
        if (hostCmd.shortAddr == undefined) {
            console.log('--- REQ_ATTR_AT_IDX HOST UNDEFINED ---');
            return; // EMBEDDED RETURN
        }
        let pktBuf = new ArrayBuffer(64);
        let pktData = new Uint8Array(pktBuf);
        let pktView = new DataView(pktBuf);
        let slMsgBuf = new Uint8Array(128);
        let i: number;
        let msgIdx: number;

        this.seqNum = ++this.seqNum % 256;
        msgIdx = 0;
        pktView.setUint16(msgIdx, gConst.SL_MSG_READ_ATTR_SET_AT_IDX, gConst.LE);
        msgIdx += 2;
        msgIdx += 2 + 1; // len + crc
        // cmd data
        pktView.setUint8(msgIdx++, this.seqNum);
        pktView.setUint16(msgIdx, hostCmd.shortAddr, gConst.LE);
        msgIdx += 2;
        pktView.setUint8(msgIdx++, hostCmd.idx);

        let msgLen = msgIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        pktView.setUint16(gConst.LEN_IDX, dataLen, gConst.LE);
        let crc = 0;
        for(i = 0; i < msgLen; i++) {
            crc ^= pktData[i];
        }
        pktView.setUint8(gConst.CRC_IDX, crc);

        this.serialSend(pktData, msgLen);
    }

    /***********************************************************************************************
     * fn          reqBindsAtIdx
     *
     * brief
     *
     */
    private reqBindAtIdx() {

        let hostCmd = this.hostCmdQueue[0];

        if (hostCmd.shortAddr == undefined) {
            console.log('----- REQ_BINDS_AT_IDX HOST UNDEFINED -----');
            return; // EMBEDDED RETURN
        }
        let pktBuf = new ArrayBuffer(64);
        let pktData = new Uint8Array(pktBuf);
        let pktView = new DataView(pktBuf);
        let slMsgBuf = new Uint8Array(128);
        let i: number;

        this.seqNum = ++this.seqNum % 256;
        let msgIdx = 0;
        pktView.setUint16(msgIdx, gConst.SL_MSG_READ_BIND_AT_IDX, gConst.LE);
        msgIdx += 2;
        msgIdx += 2 + 1; // len + crc
        // cmd data
        pktView.setUint8(msgIdx++, this.seqNum);
        pktView.setUint16(msgIdx, hostCmd.shortAddr, gConst.LE);
        msgIdx += 2;
        pktView.setUint8(msgIdx++, hostCmd.idx);

        let msgLen = msgIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        pktView.setUint16(gConst.LEN_IDX, dataLen, gConst.LE);
        let crc = 0;
        for(i = 0; i < msgLen; i++) {
            crc ^= pktData[i];
        }
        pktView.setUint8(gConst.CRC_IDX, crc);

        this.serialSend(pktData, msgLen);
    }

    /***********************************************************************************************
     * fn          wrBinds
     *
     * brief
     *
     */
    wrBind(bind: string) {
        let cmd: gIF.hostCmd_t = {
            shortAddr: 0, // not used
            type: gConst.WR_BIND,
            idx: 0, // not used
            retryCnt: gConst.RD_HOST_RETRY_CNT,
            param: bind,
        };
        this.hostCmdQueue.push(cmd);
        if(this.hostCmdFlag == false) {
            this.hostCmdFlag = true;
            this.runHostCmd();
        }
    }

    /***********************************************************************************************
     * fn          wrBindsReq
     *
     * brief
     *
     */
    private wrBindReq() {

        let hostCmd = this.hostCmdQueue[0];
        let bindSrc: gIF.hostedBind_t = JSON.parse(hostCmd.param);

        let pktBuf = new ArrayBuffer(64);
        let pktData = new Uint8Array(pktBuf);
        let pktView = new DataView(pktBuf);
        let slMsgBuf = new Uint8Array(128);
        let msgIdx: number;
        let i: number;

        this.seqNum = ++this.seqNum % 256;
        msgIdx = 0;
        pktView.setUint16(msgIdx, gConst.SL_MSG_WRITE_BIND, gConst.LE);
        msgIdx += 2;
        msgIdx += 2 + 1; // len + crc
        // cmd data
        pktView.setUint8(msgIdx++, this.seqNum);
        pktView.setUint16(msgIdx, bindSrc.hostShortAddr, gConst.LE);
        msgIdx += 2;
        pktView.setFloat64(msgIdx, bindSrc.extAddr, gConst.LE);
        msgIdx += 8;
        pktView.setUint8(msgIdx++, bindSrc.srcEP);
        pktView.setUint16(msgIdx, bindSrc.clusterID, gConst.LE);
        msgIdx += 2;
        pktView.setFloat64(msgIdx, bindSrc.dstExtAddr, gConst.LE);
        msgIdx += 8;
        pktView.setUint8(msgIdx++, bindSrc.dstEP);

        let msgLen = msgIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        pktView.setUint16(gConst.LEN_IDX, dataLen, gConst.LE);
        let crc = 0;
        for(i = 0; i < msgLen; i++) {
            crc ^= pktData[i];
        }
        pktView.setUint8(gConst.CRC_IDX, crc);

        this.serialSend(pktData, msgLen);
    }

    /***********************************************************************************************
     * fn          udpZclCmd
     *
     * brief
     *
     */
    udpZclCmd(zclCmd: string) {
        let cmd: gIF.hostCmd_t = {
            shortAddr: 0, // not used
            type: gConst.ZCL_CMD,
            idx: 0, // not used
            retryCnt: 0,
            param: zclCmd,
        };
        this.hostCmdQueue.push(cmd);
        if(this.hostCmdFlag == false) {
            this.hostCmdFlag = true;
            this.runHostCmd();
        }
    }

    /***********************************************************************************************
     * fn          zclReq
     *
     * brief
     *
     */
    private zclReq() {

        let hostCmd = this.hostCmdQueue[0];
        let req: gIF.udpZclReq_t = JSON.parse(hostCmd.param);

        let pktBuf = new ArrayBuffer(64);
        let pktData = new Uint8Array(pktBuf);
        let pktView = new DataView(pktBuf);
        let slMsgBuf = new Uint8Array(128);
        let msgIdx: number;
        let i: number;

        this.seqNum = ++this.seqNum % 256;
        msgIdx = 0;
        pktView.setUint16(msgIdx, gConst.SL_MSG_ZCL_CMD, gConst.LE);
        msgIdx += 2;
        msgIdx += 2 + 1; // len + crc
        // cmd data
        pktView.setUint8(msgIdx++, this.seqNum);
        pktView.setFloat64(msgIdx, req.extAddr, gConst.LE);
        msgIdx += 8;
        pktView.setUint8(msgIdx++, req.endPoint);
        pktView.setUint16(msgIdx, req.clusterID, gConst.LE);
        msgIdx += 2;
        pktView.setUint8(msgIdx++, req.hasRsp);
        pktView.setUint8(msgIdx++, req.cmdLen);
        for(let i = 0; i < req.cmdLen; i++) {
            pktView.setUint8(msgIdx++, req.cmd[i]);
        }
        let msgLen = msgIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        pktView.setUint16(gConst.LEN_IDX, dataLen, gConst.LE);
        let crc = 0;
        for(i = 0; i < msgLen; i++) {
            crc ^= pktData[i];
        }
        pktView.setUint8(gConst.CRC_IDX, crc);

        this.serialSend(pktData, msgLen);
    }

    /***********************************************************************************************
     * fn          serialSend
     *
     * brief
     *
     */
    serialSend(pktData: Uint8Array, msgLen: number) {

        let slMsgBuf = new Uint8Array(128);
        let msgIdx = 0;

        slMsgBuf[msgIdx++] = gConst.SL_START_CHAR;
        for(let i = 0; i < msgLen; i++) {
            if(pktData[i] < 0x10) {
                pktData[i] ^= 0x10;
                slMsgBuf[msgIdx++] = gConst.SL_ESC_CHAR;
            }
            slMsgBuf[msgIdx++] = pktData[i];
        }
        slMsgBuf[msgIdx++] = gConst.SL_END_CHAR;

        let slMsgLen = msgIdx;
        let slMsg = slMsgBuf.slice(0, slMsgLen);
        chrome.serial.send(
            this.connID,
            slMsg.buffer,
            (sendInfo: any)=>{
                if(sendInfo.error){
                    switch(sendInfo.error){
                        case 'disconnected':
                        case 'system_error': {
                            setTimeout(() => {
                                this.closeComPort();
                            }, 100);
                            break;
                        }
                        case 'pending': {
                            break;
                        }
                        case 'timeout': {
                            break;
                        }
                    }
                    this.utils.sendMsg(`send err: ${sendInfo.error}`, 'red');
                }
                /*
                if(this.tmoFlag === true){
                    this.tmoFlag = false;
                    this.hostCmdTmoRef = setTimeout(()=>{
                        this.hostCmdTmo();
                    }, gConst.RD_HOST_TMO);
                }
                */
            }
        );
    }

    /***********************************************************************************************
     * fn          rcvErrCB
     *
     * brief
     *
     */
    rcvErrCB(info: any) {
        if(info.connectionId === this.connID){
            this.utils.sendMsg(`port err: ${info.error}`, 'red');
            switch(info.error){
                case 'disconnected':
                case 'device_lost':
                case 'system_error': {
                    setTimeout(() => {
                        this.closeComPort();
                    }, 100);
                    break;
                }
                case 'timeout':
                case 'break':
                case 'frame_error':
                case 'overrun':
                case 'buffer_overflow':
                case 'parity_error': {
                    // ---
                    break;
                }
            }
        }
    }
}
