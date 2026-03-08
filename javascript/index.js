const Client = require('bitcoin-core');
const fs = require('fs');
const path = require('path');

const baseConfig = {
    network: 'regtest',
    username: 'alice',
    password: 'password',
    host: '127.0.0.1',
    port: 18443
};

const client = new Client(baseConfig);

function getWalletClient(walletName) {
    return new Client({ ...baseConfig, wallet: walletName });
}

async function loadOrCreateWallet(name) {
    try {
        await client.command('createwallet', name);
    } catch (e) {
        const msg = (e.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('database already exists')) {
            try {
                await client.command('loadwallet', name);
            } catch (le) {
                if (!(le.message || '').toLowerCase().includes('already loaded')) throw le;
            }
        } else if (!msg.includes('already loaded')) {
            throw e;
        }
    }
}

async function getPrivKeyExpr(walletClient, addr) {
    const addrInfo = await walletClient.command('getaddressinfo', addr);
    const keyIndex = addrInfo.hdkeypath.split('/').pop();

    const descList = await walletClient.command('listdescriptors', true);
    const pkhDesc = descList.descriptors.find(d => d.desc.startsWith('pkh(') && d.active && !d.internal);
    if (!pkhDesc) throw new Error('Could not find pkh descriptor');

    const keyExpr = pkhDesc.desc.slice(pkhDesc.desc.indexOf('(') + 1, pkhDesc.desc.lastIndexOf(')'));
    return keyExpr.replace('*', keyIndex);
}

async function importDescriptor(walletClient, desc) {
    const { checksum } = await client.command('getdescriptorinfo', desc);
    await walletClient.command('importdescriptors', [{ desc: `${desc}#${checksum}`, timestamp: 'now' }]);
}

async function main() {
    await loadOrCreateWallet('Miner');
    await loadOrCreateWallet('Alice');
    await loadOrCreateWallet('Bob');

    const miner = getWalletClient('Miner');
    const alice = getWalletClient('Alice');
    const bob = getWalletClient('Bob');

    // Mine blocks for spendable balance
    const minerAddress = await miner.getNewAddress();
    const { blocks } = await client.getBlockchainInfo();
    if (blocks < 103) {
        await client.command('generatetoaddress', 103 - blocks, minerAddress);
    }
    let minerBalance = await miner.getBalance();
    while (minerBalance < 150) {
        await client.command('generatetoaddress', 3, minerAddress);
        minerBalance = await miner.getBalance();
    }

    // Fund Alice and Bob with 15 BTC each
    await miner.sendToAddress(await alice.getNewAddress(), 15);
    await miner.sendToAddress(await bob.getNewAddress(), 15);
    await client.command('generatetoaddress', 6, minerAddress);

    // Get public keys from legacy addresses
    const aliceKeyAddr = await alice.getNewAddress('', 'legacy');
    const bobKeyAddr = await bob.getNewAddress('', 'legacy');
    const alicePubKey = (await alice.getAddressInfo(aliceKeyAddr)).pubkey;
    const bobPubKey = (await bob.getAddressInfo(bobKeyAddr)).pubkey;

    // Extract private key expressions for multisig descriptor import
    const alicePrivKeyExpr = await getPrivKeyExpr(alice, aliceKeyAddr);
    const bobPrivKeyExpr = await getPrivKeyExpr(bob, bobKeyAddr);

    // Create 2-of-2 P2WSH multisig address
    const { address: multisigAddress } = await client.command('createmultisig', 2, [alicePubKey, bobPubKey], 'bech32');

    // Import multisig descriptors with private keys into each wallet
    await importDescriptor(alice, `wsh(multi(2,${alicePrivKeyExpr},${bobPubKey}))`);
    await importDescriptor(bob, `wsh(multi(2,${alicePubKey},${bobPrivKeyExpr}))`);

    // Build funding PSBT
    const aliceUTXO = (await alice.command('listunspent')).find(u => u.amount >= 10);
    const bobUTXO = (await bob.command('listunspent')).find(u => u.amount >= 10);
    if (!aliceUTXO || !bobUTXO) throw new Error('Insufficient UTXOs for Alice or Bob');

    const multisigAmount = 20;
    const changeEach = parseFloat(((aliceUTXO.amount + bobUTXO.amount - multisigAmount - 0.0002) / 2).toFixed(8));

    let fundingPsbt = await client.command('createpsbt',
        [{ txid: aliceUTXO.txid, vout: aliceUTXO.vout }, { txid: bobUTXO.txid, vout: bobUTXO.vout }],
        [{ [multisigAddress]: multisigAmount }, { [await alice.getNewAddress()]: changeEach }, { [await bob.getNewAddress()]: changeEach }]
    );
    fundingPsbt = await client.command('utxoupdatepsbt', fundingPsbt);

    const aliceFundSigned = await alice.command('walletprocesspsbt', fundingPsbt);
    const bobFundSigned = await bob.command('walletprocesspsbt', fundingPsbt);

    const finalizedFunding = await client.command('finalizepsbt',
        await client.command('combinepsbt', [aliceFundSigned.psbt, bobFundSigned.psbt])
    );
    if (!finalizedFunding.complete) throw new Error('Funding PSBT could not be finalized');

    const fundingTxId = await client.sendRawTransaction(finalizedFunding.hex);
    await client.command('generatetoaddress', 6, minerAddress);

    // Build spending PSBT
    const fundingTxDetails = await client.command('getrawtransaction', fundingTxId, true);
    const multisigVout = fundingTxDetails.vout.findIndex(out =>
        Math.abs(out.value - multisigAmount) < 0.00001 &&
        out.scriptPubKey.type === 'witness_v0_scripthash'
    );
    if (multisigVout === -1) throw new Error('Multisig UTXO not found in funding transaction');

    const eachReceives = parseFloat(((multisigAmount - 0.0002) / 2).toFixed(8));

    let spendingPsbt = await client.command('createpsbt',
        [{ txid: fundingTxId, vout: multisigVout }],
        [{ [await alice.getNewAddress()]: eachReceives }, { [await bob.getNewAddress()]: eachReceives }]
    );
    const { descriptor } = await client.command('getdescriptorinfo', `wsh(multi(2,${alicePubKey},${bobPubKey}))`);
    spendingPsbt = await client.command('utxoupdatepsbt', spendingPsbt, [descriptor]);

    const aliceSpendSigned = await alice.command('walletprocesspsbt', spendingPsbt, true, 'ALL');
    const bobSpendSigned = await bob.command('walletprocesspsbt', spendingPsbt, true, 'ALL');

    const finalizedSpending = await client.command('finalizepsbt',
        await client.command('combinepsbt', [aliceSpendSigned.psbt, bobSpendSigned.psbt])
    );
    if (!finalizedSpending.complete) throw new Error('Spending PSBT could not be finalized');

    const spendingTxId = await client.sendRawTransaction(finalizedSpending.hex);
    await client.command('generatetoaddress', 6, minerAddress);

    fs.writeFileSync(path.join(__dirname, '..', 'out.txt'), `${fundingTxId}\n${spendingTxId}\n`);
    console.log('Everything went perfect and results are written down to out.txt');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
