///<reference types="chrome"/>
import { Injectable} from '@angular/core';
import { EventsService } from './events.service';
import { UtilsService } from './utils.service';
import * as gConst from '../gConst';
import * as gIF from '../gIF';

interface sl_msg {
    type: number;
    nodeBuf: any;
}

@Injectable({
    providedIn: 'root',
})
export class SerialPortService {

    private searchPortFlag = false;
    //private validPortFlag = false;
    //private portOpenFlag = false;
    private portIdx = 0;
    private portPath = '';

    private testPortTMO = null;

    private crc: number;
    private calcCRC: number;
    private msgIdx: number;
    private isEsc = false;

    private rxState: gIF.eRxState = gIF.eRxState.E_STATE_RX_WAIT_START;

    private msgType: number;
    private msgLen: number;

    private seqNum = 0;
    spCmd = {} as gIF.spCmd_t;

    private spCmdQueue: gIF.spCmd_t[] = [];
    private spCmdFlag = false;
    private spCmdTmoRef;
    private runTmoRef = null;

    private tmoFlag = false;

    private comFlag = false;
    private comPorts = [];
    private connID = -1;

    rxNodeBuf = window.nw.Buffer.alloc(1024);
    txNodeBuf = window.nw.Buffer.alloc(1024);
    rwBuf = new gIF.rwBuf_t();

    slMsg = {} as sl_msg;

    constructor(private events: EventsService,
                private utils: UtilsService) {
        this.rwBuf.wrBuf = this.txNodeBuf;
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
    async checkCom() {
        if(this.comFlag == false) {
            this.spCmdQueue = [];
            this.spCmdFlag = false;
            await this.closeComPort();
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
    async closeComPort() {
        if(this.connID > -1){
            this.utils.sendMsg('close port', 'red');
            this.events.publish('closePort', 'close');
            const result = await this.closePortAsync(this.connID);
            if(result){
                this.connID = -1;
                //this.portOpenFlag = false;
                //this.validPortFlag = false;
                setTimeout(() => {
                    this.findComPort();
                }, 200);
            }
        }
    }

    /***********************************************************************************************
     * fn          closePortAsync
     *
     * brief
     *
     */
    closePortAsync(id: number) {
        return new Promise((resolve)=>{
            chrome.serial.disconnect(id, (result)=>{
                resolve(result);
            });
        });
    }

    /***********************************************************************************************
     * fn          listComPorts
     *
     * brief
     *
     */
    listComPorts() {
        chrome.serial.getDevices((ports)=>{
            this.comPorts = ports;
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
    async findComPort() {

        if(this.searchPortFlag === false){
            setTimeout(()=>{
                this.listComPorts();
            }, 1000);
            return;
        }
        this.portPath = this.comPorts[this.portIdx].path;
        this.utils.sendMsg(`testing: ${this.portPath}`, 'blue');
        let connOpts = {
            bitrate: 115200
        };
        const connInfo: any = await this.serialConnectAsync(connOpts);
        if(connInfo){
            this.connID = connInfo.connectionId;
            //this.portOpenFlag = true;
            this.testPortTMO = setTimeout(()=>{
                this.closeComPort();
            }, 1000);
            setTimeout(() => {
                this.testPortReq();
            }, 10);
        }
        else {
            this.utils.sendMsg(`err: ${chrome.runtime.lastError.message}`, 'red');
            setTimeout(() => {
                this.findComPort();
            }, 10);
        }
        this.portIdx++;
        if(this.portIdx >= this.comPorts.length) {
            this.searchPortFlag = false;
        }
    }

    /***********************************************************************************************
     * fn          serialConnectAsync
     *
     * brief
     *
     */
    serialConnectAsync(connOpt) {
        return new Promise((resolve)=>{
            chrome.serial.connect(this.portPath, connOpt, (connInfo)=>{
                resolve(connInfo);
            });
        });
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
                        this.slMsg.type = this.msgType;
                        this.slMsg.nodeBuf = this.rxNodeBuf.subarray(0, this.msgLen);
                        setTimeout(() => {
                            this.processMsg(this.slMsg);
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
                                this.rxNodeBuf[this.msgIdx++] = rxByte;
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
    private processMsg(slMsg: sl_msg) {

        this.comFlag = true;

        this.rwBuf.rdBuf = slMsg.nodeBuf;
        this.rwBuf.rdIdx = 0;

        switch(slMsg.type) {
            case gConst.SL_MSG_TESTPORT: {
                const msgSeqNum = this.rwBuf.read_uint8();
                if (msgSeqNum == this.seqNum) {
                    const idNum = this.rwBuf.read_uint32_LE();
                    if(idNum === 0x67190110) {
                        clearTimeout(this.testPortTMO);
                        //this.validPortFlag = true;
                        this.searchPortFlag = false;
                        this.utils.sendMsg('port valid', 'green');
                    }
                }
                break;
            }
            case gConst.SL_MSG_HOST_ANNCE: {
                const dataHost = {} as gIF.dataHost_t;
                dataHost.shortAddr = this.rwBuf.read_uint16_LE();
                dataHost.extAddr = this.rwBuf.read_double_LE();
                dataHost.numAttrSets = this.rwBuf.read_uint8();
                dataHost.numSrcBinds = this.rwBuf.read_uint8();

                setTimeout(() => {
                    let log = 'host ->';
                    log += ` short: 0x${dataHost.shortAddr.toString(16).padStart(4, '0').toUpperCase()},`;
                    log += ` ext: ${this.utils.extToHex(dataHost.extAddr)},`;
                    log += ` numAttr: ${dataHost.numAttrSets},`;
                    log += ` numBinds: ${dataHost.numSrcBinds}`;
                    this.utils.sendMsg(log);
                }, 5);

                if(this.spCmdQueue.length > 15) {
                    this.spCmdQueue = [];
                    this.spCmdFlag = false;
                }
                const param: gIF.rdAtIdxParam_t = {
                    shortAddr: dataHost.shortAddr,
                    idx: 0
                }
                if(dataHost.numAttrSets > 0) {
                    const cmd: gIF.spCmd_t = {
                        type: gConst.RD_ATTR,
                        retryCnt: gConst.RD_HOST_RETRY_CNT,
                        param: JSON.stringify(param)
                    };
                    this.spCmdQueue.push(cmd);
                }
                if(dataHost.numSrcBinds > 0) {
                    const cmd: gIF.spCmd_t = {
                        type: gConst.RD_BIND,
                        retryCnt: gConst.RD_HOST_RETRY_CNT,
                        param: JSON.stringify(param)
                    };
                    this.spCmdQueue.push(cmd);
                }
                if(this.spCmdQueue.length > 0) {
                    if(this.spCmdFlag === false) {
                        this.spCmdFlag = true;
                        this.runCmd();
                    }
                    if(this.runTmoRef === null) {
                        this.runTmoRef = setTimeout(()=>{
                            this.runTmoRef = null;
                            this.spCmdFlag = true;
                            this.runCmd();
                        }, 3000);
                    }
                }
                break;
            }
            case gConst.SL_MSG_LOG: {

                let idx = slMsg.nodeBuf.indexOf(10);
                if(idx > -1) {
                    slMsg.nodeBuf[idx] = 32;
                }
                idx = slMsg.nodeBuf.indexOf(0);
                if(idx > -1) {
                    slMsg.nodeBuf[idx] = 32;
                }

                this.utils.sendMsg(String.fromCharCode.apply(null, slMsg.nodeBuf));
                break;
            }
            case gConst.SL_MSG_READ_ATTR_SET_AT_IDX: {
                const rxSet = {} as gIF.attrSet_t;
                const msgSeqNum = this.rwBuf.read_uint8();
                if(msgSeqNum == this.seqNum) {
                    const param: gIF.rdAtIdxParam_t = JSON.parse(this.spCmd.param);
                    rxSet.hostShortAddr = param.shortAddr;
                    const status = this.rwBuf.read_uint8();
                    if(status == gConst.SL_CMD_OK) {
                        const memIdx = this.rwBuf.read_uint8();
                        rxSet.partNum = this.rwBuf.read_uint32_LE();
                        rxSet.clusterServer = this.rwBuf.read_uint8();
                        rxSet.extAddr = this.rwBuf.read_double_LE();
                        rxSet.shortAddr = this.rwBuf.read_uint16_LE();
                        rxSet.endPoint = this.rwBuf.read_uint8();
                        rxSet.clusterID = this.rwBuf.read_uint16_LE();
                        rxSet.attrSetID = this.rwBuf.read_uint16_LE();
                        rxSet.attrMap = this.rwBuf.read_uint16_LE();
                        rxSet.valsLen = this.rwBuf.read_uint8();
                        rxSet.attrVals = [];
                        for(let i = 0; i < rxSet.valsLen; i++) {
                            rxSet.attrVals[i] = this.rwBuf.read_uint8();
                        }
                        this.events.publish('attr_set', rxSet);

                        param.idx = memIdx + 1;
                        this.spCmd.param = JSON.stringify(param);
                        this.spCmd.retryCnt = gConst.RD_HOST_RETRY_CNT;
                        this.spCmdQueue.push(this.spCmd);
                        this.runCmd();
                    }
                    else {
                        if(this.spCmdQueue.length > 0) {
                            this.runCmd();
                        }
                        else {
                            this.seqNum = ++this.seqNum % 256;
                            clearTimeout(this.spCmdTmoRef);
                            this.spCmdFlag = false;
                        }
                    }
                }
                break;
            }
            case gConst.SL_MSG_READ_BIND_AT_IDX: {
                const rxBind = {} as gIF.clusterBind_t;
                const msgSeqNum = this.rwBuf.read_uint8();
                if(msgSeqNum == this.seqNum) {
                    const param: gIF.rdAtIdxParam_t = JSON.parse(this.spCmd.param);
                    rxBind.hostShortAddr = param.shortAddr;
                    const status = this.rwBuf.read_uint8();
                    if(status == gConst.SL_CMD_OK) {
                        let memIdx = this.rwBuf.read_uint8();
                        rxBind.partNum = this.rwBuf.read_uint32_LE();
                        rxBind.extAddr = this.rwBuf.read_double_LE();
                        rxBind.srcShortAddr = this.rwBuf.read_uint16_LE();
                        rxBind.srcEP = this.rwBuf.read_uint8();
                        rxBind.clusterID = this.rwBuf.read_uint16_LE();
                        rxBind.dstExtAddr = this.rwBuf.read_double_LE();
                        rxBind.dstEP = this.rwBuf.read_uint8();
                        this.events.publish('cluster_bind', rxBind);

                        param.idx = memIdx + 1;
                        this.spCmd.param = JSON.stringify(param);
                        this.spCmd.retryCnt = gConst.RD_HOST_RETRY_CNT;
                        this.spCmdQueue.push(this.spCmd);
                        this.runCmd();
                    }
                    else {
                        if(this.spCmdQueue.length > 0) {
                            this.runCmd();
                        }
                        else {
                            this.seqNum = ++this.seqNum % 256;
                            clearTimeout(this.spCmdTmoRef);
                            this.spCmdFlag = false;
                        }
                    }
                }
                break;
            }
            case gConst.SL_MSG_WRITE_BIND: {
                const msgSeqNum = this.rwBuf.read_uint8();
                if(msgSeqNum == this.seqNum) {
                    const status = this.rwBuf.read_uint8();
                    if(status == gConst.SL_CMD_OK) {
                        this.utils.sendMsg('wr binds status: OK');
                    }
                    else {
                        this.utils.sendMsg('wr binds status: FAIL');
                    }
                    if(this.spCmdQueue.length > 0) {
                        this.runCmd();
                    }
                    else {
                        this.seqNum = ++this.seqNum % 256;
                        clearTimeout(this.spCmdTmoRef);
                        this.spCmdFlag = false;
                    }
                }
                break;
            }
            case gConst.SL_MSG_ZCL_CMD: {
                const msgSeqNum = this.rwBuf.read_uint8();
                if(msgSeqNum == this.seqNum) {
                    const zclCmd: gIF.udpZclReq_t = JSON.parse(this.spCmd.param);
                    if(zclCmd.ip){
                        const zclRsp = {} as gIF.udpZclRsp_t;
                        zclRsp.seqNum = zclCmd.seqNum;
                        zclRsp.ip = zclCmd.ip;
                        zclRsp.port = zclCmd.port;
                        zclRsp.extAddr = this.rwBuf.read_double_LE();
                        zclRsp.endPoint = this.rwBuf.read_uint8();
                        zclRsp.clusterID = this.rwBuf.read_uint16_LE();
                        zclRsp.status = this.rwBuf.read_uint8();
                        this.events.publish('zcl_rsp', zclRsp);
                    }
                    if(this.spCmdQueue.length > 0) {
                        this.runCmd();
                    }
                    else {
                        this.seqNum = ++this.seqNum % 256;
                        clearTimeout(this.spCmdTmoRef);
                        this.spCmdFlag = false;
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
     * fn          runCmd
     *
     * brief
     *
     */
    private runCmd() {

        clearTimeout(this.spCmdTmoRef);

        if(this.runTmoRef) {
            clearTimeout(this.runTmoRef);
            this.runTmoRef = null;
        }
        this.spCmd = this.spCmdQueue.shift();
        if(this.spCmd) {
            switch(this.spCmd.type) {
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
        this.spCmdTmoRef = setTimeout(()=>{
            this.spCmdTmo();
        }, gConst.RD_HOST_TMO);
    }

    /***********************************************************************************************
     * fn          spCmdTmo
     *
     * brief
     *
     */
    private spCmdTmo() {

        this.utils.sendMsg('--- READ_HOST_TMO ---', 'red');

        if(this.spCmd.retryCnt > 0) {
            this.spCmd.retryCnt--;
            this.spCmdQueue.push(this.spCmd);
        }
        if(this.spCmdQueue.length === 0) {
            this.spCmdFlag = false;
            return;
        }
        this.spCmd = this.spCmdQueue.shift();
        switch (this.spCmd.type) {
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
        this.spCmdTmoRef = setTimeout(()=>{
            this.spCmdTmo();
        }, gConst.RD_HOST_TMO);
    }

    /***********************************************************************************************
     * fn          testPortReq
     *
     * brief
     *
     */
    async testPortReq() {

        this.seqNum = ++this.seqNum % 256;
        this.rwBuf.wrIdx = 0;

        this.rwBuf.write_uint16_LE(gConst.SL_MSG_TESTPORT);
        this.rwBuf.write_uint16_LE(0); // len
        this.rwBuf.write_uint8(0);     // CRC
        // cmd data
        this.rwBuf.write_uint8(this.seqNum);
        this.rwBuf.write_uint32_LE(0x67190110);

        const msgLen = this.rwBuf.wrIdx;
        let dataLen = msgLen - gConst.HEAD_LEN;
        this.rwBuf.modify_uint16_LE(dataLen, gConst.LEN_IDX);
        let crc = 0;
        for(let i = 0; i < msgLen; i++) {
            crc ^= this.txNodeBuf[i];
        }
        this.rwBuf.modify_uint8(crc, gConst.CRC_IDX);

        await this.serialSend(msgLen);
    }

    /***********************************************************************************************
     * fn          reqAttrAtIdx
     *
     * brief
     *
     */
    async reqAttrAtIdx() {

        const param: gIF.rdAtIdxParam_t = JSON.parse(this.spCmd.param);
        this.seqNum = ++this.seqNum % 256;
        this.rwBuf.wrIdx = 0;

        this.rwBuf.write_uint16_LE(gConst.SL_MSG_READ_ATTR_SET_AT_IDX);
        this.rwBuf.write_uint16_LE(0); // len
        this.rwBuf.write_uint8(0);     // CRC
        // cmd data
        this.rwBuf.write_uint8(this.seqNum);
        this.rwBuf.write_uint16_LE(param.shortAddr);
        this.rwBuf.write_uint8(param.idx);

        const msgLen = this.rwBuf.wrIdx;
        const dataLen = msgLen - gConst.HEAD_LEN;
        this.rwBuf.modify_uint16_LE(dataLen, gConst.LEN_IDX);
        let crc = 0;
        for(let i = 0; i < msgLen; i++) {
            crc ^= this.txNodeBuf[i];
        }
        this.rwBuf.modify_uint8(crc, gConst.CRC_IDX);

        await this.serialSend(msgLen);
    }

    /***********************************************************************************************
     * fn          reqBindsAtIdx
     *
     * brief
     *
     */
    async reqBindAtIdx() {

        const param: gIF.rdAtIdxParam_t = JSON.parse(this.spCmd.param);
        this.seqNum = ++this.seqNum % 256;
        this.rwBuf.wrIdx = 0;

        this.rwBuf.write_uint16_LE(gConst.SL_MSG_READ_BIND_AT_IDX);
        this.rwBuf.write_uint16_LE(0); // len
        this.rwBuf.write_uint8(0);     // CRC
        // cmd data
        this.rwBuf.write_uint8(this.seqNum);
        this.rwBuf.write_uint16_LE(param.shortAddr);
        this.rwBuf.write_uint8(param.idx);

        const msgLen = this.rwBuf.wrIdx;
        const dataLen = msgLen - gConst.HEAD_LEN;
        this.rwBuf.modify_uint16_LE(dataLen, gConst.LEN_IDX);
        let crc = 0;
        for(let i = 0; i < msgLen; i++) {
            crc ^= this.txNodeBuf[i];
        }
        this.rwBuf.modify_uint8(crc, gConst.CRC_IDX);

        await this.serialSend(msgLen);
    }

    /***********************************************************************************************
     * fn          wrBind
     *
     * brief
     *
     */
    wrBind(bind: string) {
        const cmd: gIF.spCmd_t = {
            type: gConst.WR_BIND,
            retryCnt: gConst.RD_HOST_RETRY_CNT,
            param: bind,
        };
        this.spCmdQueue.push(cmd);
        if(this.spCmdFlag == false) {
            this.spCmdFlag = true;
            this.runCmd();
        }
    }

    /***********************************************************************************************
     * fn          wrBindReq
     *
     * brief
     *
     */
    async wrBindReq() {

        const req: gIF.hostedBind_t = JSON.parse(this.spCmd.param);
        this.seqNum = ++this.seqNum % 256;

        this.rwBuf.wrIdx = 0;
        this.rwBuf.write_uint16_LE(gConst.SL_MSG_WRITE_BIND);
        this.rwBuf.write_uint16_LE(0); // len
        this.rwBuf.write_uint8(0);     // CRC
        // cmd data
        this.rwBuf.write_uint8(this.seqNum);
        this.rwBuf.write_uint16_LE(req.hostShortAddr);
        this.rwBuf.write_double_LE(req.extAddr);
        this.rwBuf.write_uint8(req.srcEP);
        this.rwBuf.write_uint16_LE(req.clusterID);
        this.rwBuf.write_double_LE(req.dstExtAddr);
        this.rwBuf.write_uint8(req.dstEP);

        const msgLen = this.rwBuf.wrIdx;
        const dataLen = msgLen - gConst.HEAD_LEN;
        this.rwBuf.modify_uint16_LE(dataLen, gConst.LEN_IDX);
        let crc = 0;
        for(let i = 0; i < msgLen; i++) {
            crc ^= this.txNodeBuf[i];
        }
        this.rwBuf.modify_uint8(crc, gConst.CRC_IDX);

        await this.serialSend(msgLen);
    }

    /***********************************************************************************************
     * fn          udpZclCmd
     *
     * brief
     *
     */
    udpZclCmd(zclCmd: gIF.udpZclReq_t) {
        let cmd: gIF.spCmd_t = {
            type: gConst.ZCL_CMD,
            retryCnt: 0,
            param: JSON.stringify(zclCmd),
        };
        this.spCmdQueue.push(cmd);
        if(this.spCmdFlag == false) {
            this.spCmdFlag = true;
            this.runCmd();
        }
    }

    /***********************************************************************************************
     * fn          zclReq
     *
     * brief
     *
     */
    async zclReq() {

        const req: gIF.udpZclReq_t = JSON.parse(this.spCmd.param);
        this.seqNum = ++this.seqNum % 256;

        this.rwBuf.wrIdx = 0;
        this.rwBuf.write_uint16_LE(gConst.SL_MSG_ZCL_CMD);
        this.rwBuf.write_uint16_LE(0); // len
        this.rwBuf.write_uint8(0);     // CRC
        // cmd data
        this.rwBuf.write_uint8(this.seqNum);
        this.rwBuf.write_double_LE(req.extAddr);
        this.rwBuf.write_uint8(req.endPoint);
        this.rwBuf.write_uint16_LE(req.clusterID);
        this.rwBuf.write_uint8(req.hasRsp);
        this.rwBuf.write_uint8(req.cmdLen);
        for(let i = 0; i < req.cmdLen; i++) {
            this.rwBuf.write_uint8(req.cmd[i]);
        }
        const msgLen = this.rwBuf.wrIdx;
        const dataLen = msgLen - gConst.HEAD_LEN;
        this.rwBuf.modify_uint16_LE(dataLen, gConst.LEN_IDX);
        let crc = 0;
        for(let i = 0; i < msgLen; i++) {
            crc ^= this.txNodeBuf[i];
        }
        this.rwBuf.modify_uint8(crc, gConst.CRC_IDX);

        await this.serialSend(msgLen);
    }

    /***********************************************************************************************
     * fn          serialSend
     *
     * brief
     *
     */
    async serialSend(msgLen: number) {

        let slMsgBuf = new Uint8Array(256);
        let msgIdx = 0;

        slMsgBuf[msgIdx++] = gConst.SL_START_CHAR;
        for(let i = 0; i < msgLen; i++) {
            if(this.txNodeBuf[i] < 0x10) {
                this.txNodeBuf[i] ^= 0x10;
                slMsgBuf[msgIdx++] = gConst.SL_ESC_CHAR;
            }
            slMsgBuf[msgIdx++] = this.txNodeBuf[i];
        }
        slMsgBuf[msgIdx++] = gConst.SL_END_CHAR;

        let slMsgLen = msgIdx;
        let slMsg = slMsgBuf.slice(0, slMsgLen);

        const sendInfo: any = await this.serialSendAsync(slMsg);
        if(sendInfo.error){
            this.utils.sendMsg(`send err: ${sendInfo.error}`, 'red');
        }
    }

    /***********************************************************************************************
     * fn          serialSendAsync
     *
     * brief
     *
     */
    serialSendAsync(slMsg: any) {
        return new Promise((resolve)=>{
            chrome.serial.send(this.connID, slMsg.buffer, (sendInfo: any)=>{
                resolve(sendInfo);
            });
        });
    }

    /***********************************************************************************************
     * fn          rcvErrCB
     *
     * brief
     *
     */
    async rcvErrCB(info: any) {
        if(info.connectionId === this.connID){
            switch(info.error){
                case 'disconnected': {
                    this.utils.sendMsg(`${this.portPath} disconnected`);
                    setTimeout(()=>{
                        this.closeComPort();
                    }, 10);
                    break;
                }
                case 'device_lost': {
                    this.utils.sendMsg(`${this.portPath} lost`, 'red');
                    setTimeout(()=>{
                        this.closeComPort();
                    }, 10);
                    break;
                }
                case 'system_error': {
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
