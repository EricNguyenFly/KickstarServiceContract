import hre, { upgrades } from "hardhat";
import fs from "fs";
import {
	KickstarService__factory,
	KickstarService
} from "../typechain-types";
import { parseEther } from "ethers/lib/utils";

async function main() {
	//* Loading accounts */
	const accounts = await hre.ethers.getSigners();

	console.log('=====================================================================================');
	console.log('ACCOUNTS:');
	console.log('=====================================================================================');
	for (let i = 0; i < accounts.length; i++) {
		const account = accounts[i];
		console.log(` Account ${i}: ${account.address}`);
	}

	//* Loading contract factory */
	const KickstarService: KickstarService__factory = await hre.ethers.getContractFactory("KickstarService");

	//* Deploy contracts */
	console.log("================================================================================");
	console.log("DEPLOYING CONTRACTS");
	console.log("================================================================================");

	const kickstarService = await upgrades.deployProxy(KickstarService, [accounts[0].address]) as KickstarService;
	await kickstarService.deployed();
	console.log("KickstarService                          deployed to:>>", kickstarService.address);
	const kickstarServiceVerify = await upgrades.erc1967.getImplementationAddress(kickstarService.address);
	console.log("KickstarService                        verify addr:>>", kickstarServiceVerify);

	console.log("================================================================================");
	console.log("DONE");
	console.log("================================================================================");

	const contracts = {
		kickstarService: kickstarService.address
	};

	await fs.writeFileSync("contracts.json", JSON.stringify(contracts));

	const contractVerify = {
		kickstarService: kickstarServiceVerify
	};

	await fs.writeFileSync("contracts-verify.json", JSON.stringify(contractVerify));

	await hre
		.run("verify:verify", {
			address: kickstarServiceVerify,
		})
		.catch(console.log);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
