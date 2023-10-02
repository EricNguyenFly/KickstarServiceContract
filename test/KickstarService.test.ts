import { expect } from "chai";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { upgrades, ethers } from "hardhat";
import { ZERO_ADDRESS as AddressZero, MAX_UINT256 as MaxUint256, BN, ZERO_ADDRESS, getTimestamp } from "./utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    TokenTest__factory,
    TokenTest,
    KickstarService__factory,
    KickstarService,
    Referral__factory,
    Referral
} from "../typechain-types";
import { BigNumber } from "ethers";

// signer variables
let owner: SignerWithAddress;
let admin: SignerWithAddress;
let user1: SignerWithAddress;
let user2: SignerWithAddress;
let accounts: SignerWithAddress[];

// contract instance
let kickstarService: KickstarService;
let tokenTest: TokenTest;
let referral: Referral;

// constants
let DENOMINATOR: BN;
const ETH_100 = parseUnits("100", 18);
const ETH_1000 = parseUnits("1000", 18);
const ONE_DAY = 86400;
const PayType = {
    ALL: 0,
    MILESTONE: 1
}
const ProjectStatus = {
    PROCESSING: 0,
    FINISHED: 1,
    STOPPED: 2
}
const MilestoneStatus = {
    CREATED: 0,
    PAID: 1,
    ACCEPTED: 2,
    CLAIMED: 3,
    CANCELED: 4
}

describe("KickstarService", () => {
    beforeEach(async () => {
        [owner, admin, user1, user2, ...accounts] = await ethers.getSigners();

        const TokenTest: TokenTest__factory = await ethers.getContractFactory("TokenTest");
        tokenTest = (await TokenTest.deploy()) as TokenTest;

        const Referral: Referral__factory = await ethers.getContractFactory("Referral");
        referral = (await Referral.deploy(owner.address)) as Referral;
        await referral.deployed();

        const KickstarService: KickstarService__factory = await ethers.getContractFactory("KickstarService");
        kickstarService = (await upgrades.deployProxy(KickstarService, [owner.address, referral.address])) as KickstarService;
        await kickstarService.deployed();

        await tokenTest.mint(user1.address, ETH_1000);
        await tokenTest.connect(user1).approve(kickstarService.address, MaxUint256);

        DENOMINATOR = await kickstarService.FEE_DENOMINATOR();
        await kickstarService.toggle();
    });

    describe("Deployment", () => {
        it("should revert with contract is already initialized", async () => {
            await expect(kickstarService.initialize(owner.address, referral.address)).to.be.revertedWith("Initializable: contract is already initialized");
        });

        it("Check parameters", async () => {
            expect(await kickstarService.owner()).to.equal(owner.address);
            expect(await kickstarService.referral()).to.equal(referral.address);
            expect(await kickstarService.referral()).to.equal(referral.address);
        });
    });

    describe("setPermittedToken", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setPermittedToken(tokenTest.address, true)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with pause", async () => {
            await kickstarService.toggle();
            expect(await kickstarService.paused()).to.be.true;
            await expect(kickstarService.setPermittedToken(tokenTest.address, true)).to.be.revertedWith("Pausable: paused");
        });

        it("should setPermittedToken successfully", async () => {
            await expect(kickstarService.setPermittedToken(tokenTest.address, true))
                .to.emit(kickstarService, "SetPermittedToken")
                .withArgs(tokenTest.address, true);
        });
    });

    describe("setServiceFeePercent", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(user1).setServiceFeePercent(100, 100)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid service fee percent", async () => {
            await expect(kickstarService.setServiceFeePercent(0, 100)).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(100, 0)).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(100, DENOMINATOR.add(1))).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(DENOMINATOR.add(1), 100)).to.be.revertedWith("Invalid service fee percent");
        });

        it("should setServiceFeePercent successfully", async () => {
            const clientFeePercent = await kickstarService.clientFeePercent();
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            await expect(kickstarService.setServiceFeePercent(100, 100))
                .to.emit(kickstarService, "SetServiceFeePercent")
                .withArgs(clientFeePercent, freelancerFeePercent, 100, 100);
        });
    });

    describe("setMaxMilestone", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setMaxMilestone(5)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid maxMilestone", async () => {
            await expect(kickstarService.setMaxMilestone(0)).to.be.revertedWith("Invalid maxMilestone");
        });

        it("should setMaxMilestone successfully", async () => {
            const maxMilestone = await kickstarService.maxMilestone();
            await expect(kickstarService.setMaxMilestone(5))
                .to.emit(kickstarService, "SetMaxMilestone")
                .withArgs(maxMilestone, 5);

            expect(await kickstarService.maxMilestone()).to.equal(5);
        });
    });

    describe("setReferralContract", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setReferralContract(referral.address)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid address", async () => {
            await expect(kickstarService.setReferralContract(AddressZero)).to.be.revertedWith("Invalid address");
        });

        it("should revert with already exists", async () => {
            await expect(kickstarService.setReferralContract(referral.address)).to.be.revertedWith("Already exist");
        });

        it("should setReferralContract successfully", async () => {
            const referral = await kickstarService.referral();
            await expect(kickstarService.setReferralContract(tokenTest.address))
                .to.emit(kickstarService, "SetReferralContract")
                .withArgs(referral, tokenTest.address);
        });
    });

    describe("acceptBid", () => {
        const BUDGET = parseUnits("400", 18);
        let currentTime: any;

        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);
        })

        it("should revert with invalid address", async () => {
            await expect(kickstarService.connect(user1).acceptBid(AddressZero, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid address");
        });

        it("should revert with Freelancer can not be same", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user1.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Freelancer can not be same");
        });

        it("should revert with Invalid payment token", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, referral.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid payment token");
        });

        it("should revert with Budget must be greater than 0", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, 0, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Budget must be greater than 0");
        });

        it("should revert with Invalid length", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid length");
            await kickstarService.setMaxMilestone(1);
            await kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET], PayType.ALL);
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET, BUDGET], PayType.ALL)).to.be.revertedWith("Invalid length");
        });

        it("should revert with Invalid expired date", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, 0, [BUDGET], PayType.ALL)).to.be.revertedWith("Invalid expired date");
        });

        it("should revert with Invalid amount of milestone", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [0], PayType.ALL)).to.be.revertedWith("Invalid amount of milestone");
        });

        it("should revert with Invalid total amount", async () => {
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET.sub(1)], PayType.ALL)).to.be.revertedWith("Invalid total amount");
        });

        it("it should successfully with pay all", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL))
                .changeTokenBalances(tokenTest, [user1, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.projects(lastId);
            expect(project.freelancer).to.equal(user2.address);
            expect(project.client).to.equal(user1.address);
            expect(project.paymentToken).to.equal(tokenTest.address);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budget);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.ALL);

            let milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);

            milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone.add(budgetMilestones.length - 1));
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[budgetMilestones.length - 1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay milestone", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(user1).acceptBid(user2.address, tokenTest.address, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE))
                .changeTokenBalances(tokenTest, [user1, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.projects(lastId);
            expect(project.freelancer).to.equal(user2.address);
            expect(project.client).to.equal(user1.address);
            expect(project.paymentToken).to.equal(tokenTest.address);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budgetMilestones[0]);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts[0]);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.MILESTONE);

            const milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay all and pay by native", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(user1).acceptBid(user2.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([user1, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.projects(lastId);
            expect(project.freelancer).to.equal(user2.address);
            expect(project.client).to.equal(user1.address);
            expect(project.paymentToken).to.equal(AddressZero);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budget);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.ALL);

            let milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);

            milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone.add(budgetMilestones.length - 1));
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[budgetMilestones.length - 1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay milestone and pay by native", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(user1).acceptBid(user2.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE, { value: amountDeposit }))
                .changeEtherBalances([user1, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.projects(lastId);
            expect(project.freelancer).to.equal(user2.address);
            expect(project.client).to.equal(user1.address);
            expect(project.paymentToken).to.equal(AddressZero);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budgetMilestones[0]);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts[0]);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.MILESTONE);

            const milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        // it("shoud revert with invalid amount", async () => {
        //     await expect(
        //         kickstarService.connect(kickstarServiceOwner1).createProject("97", AddressZero, parseEther("10"), collectionInfos, {
        //             value: parseEther("9"),
        //         })
        //     ).to.be.revertedWith("Invalid amount");
        // });

        // it("should revert with transfer amount exceeds balance", async () => {
        //     await hlpToken.connect(kickstarServiceOwner2).approve(kickstarService.address, MaxUint256);
        //     await expect(kickstarService.connect(kickstarServiceOwner2).createProject("97", hlpToken.address, BUDGET, collectionInfos)).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        // });

        // it("should revert with insufficient allowance", async () => {
        //     await hlpToken.mint(kickstarServiceOwner2.address, "10000000000000000000000");

        //     await expect(kickstarService.connect(kickstarServiceOwner2).createProject("97", hlpToken.address, BUDGET, collectionInfos)).to.be.revertedWith("ERC20: insufficient allowance");
        // });

        // it("should revert with The total percentage must be equal to 100%", async () => {
        //     collectionInfos[0].rewardPercent = 1e3;
        //     await expect(kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos)).to.be.revertedWith("The total percentage must be equal to 100%");
        // });

        // it("should create new kickstarService successfully", async () => {
        //     // Project 1
        //     const collectionInfos: CollectionInfoStruct[] = [
        //         {
        //             collectionAddress: genesis.address,
        //             rewardPercent: 1e4,
        //             rewardRarityPercents: [7208, 2520, 252, 18, 2],
        //         },
        //     ];

        //     let kickstarServiceId: number = (await kickstarService.getProjectCounter()).toNumber() + 1;

        //     await expect(kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos))
        //         .to.emit(kickstarService, "CreatedProject")
        //         .withArgs(kickstarServiceId, "97");
        //     let currentProject = await kickstarService.getProjectById(kickstarServiceId);
        //     expect(currentProject.kickstarServiceId).to.equal(kickstarServiceId);
        //     expect(currentProject.idOffChain).to.equal("97");
        //     expect(currentProject.paymentToken).to.equal(hlpToken.address);
        //     expect(currentProject.kickstarServiceOwner).to.equal(kickstarServiceOwner1.address);
        //     expect(currentProject.budget).to.equal(0);
        //     expect(currentProject.status).to.be.true;
        //     expect(currentProject.claimPool).not.equal(AddressZero);
        //     expect((await kickstarService.collectionInfos(genesis.address, kickstarServiceId)).rewardPercent).to.equal(1e4);
        //     expect((await kickstarService.collectionInfos(genesis.address, kickstarServiceId)).collectionAddress).to.equal(genesis.address);
        //     expect(await kickstarService.collectionToProjects(genesis.address)).to.equal(kickstarServiceId);

        //     // Project 2
        //     const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
        //     let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address, "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

        //     collectionInfos[0] = {
        //         collectionAddress: newHLPeaceGenesisAngel.address,
        //         rewardPercent: 1e4,
        //         rewardRarityPercents: [],
        //     };

        //     kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber() + 1;
        //     await expect(kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, BUDGET, collectionInfos))
        //         .to.emit(kickstarService, "CreatedProject")
        //         .withArgs(kickstarServiceId, "97")
        //         .to.changeTokenBalance(hlpToken, kickstarServiceOwner1.address, `-${BUDGET}`);

        //     currentProject = await kickstarService.getProjectById(kickstarServiceId);
        //     expect(currentProject.kickstarServiceId).to.equal(kickstarServiceId);
        //     expect(currentProject.paymentToken).to.equal(hlpToken.address);
        //     expect(currentProject.kickstarServiceOwner).to.equal(kickstarServiceOwner1.address);
        //     expect(currentProject.budget).to.equal(BUDGET);
        //     expect(currentProject.status).to.be.true;
        //     expect(currentProject.claimPool).not.equal(AddressZero);
        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).rewardPercent).to.equal(1e4);
        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).collectionAddress).to.equal(newHLPeaceGenesisAngel.address);
        //     expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel.address)).to.equal(kickstarServiceId);
        //     expect(await hlpToken.balanceOf(currentProject.claimPool)).to.equal(BUDGET);

        //     const provider = ethers.provider;
        //     let claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
        //     expect(await claimPoolContract.kickstarService()).to.equal(kickstarService.address);
        //     expect(await claimPoolContract.paymentToken()).to.equal(hlpToken.address);
        //     expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel.address)).to.equal(BUDGET);

        //     // Project 3
        //     const newHLPeaceGenesisAngel1 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address, "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

        //     collectionInfos[0] = {
        //         collectionAddress: newHLPeaceGenesisAngel1.address,
        //         rewardPercent: 3 * 1e3,
        //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
        //     };

        //     const newHLPeaceGenesisAngel2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address, "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

        //     collectionInfos.push({
        //         collectionAddress: newHLPeaceGenesisAngel2.address,
        //         rewardPercent: 7 * 1e3,
        //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
        //     });

        //     const ETH_BUDGET = parseEther("100");

        //     kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber() + 1;
        //     await expect(
        //         kickstarService.connect(kickstarServiceOwner2).createProject("97", AddressZero, ETH_BUDGET, collectionInfos, {
        //             value: ETH_BUDGET,
        //         })
        //     )
        //         .to.emit(kickstarService, "CreatedProject")
        //         .withArgs(kickstarServiceId, "97")
        //         .to.changeEtherBalance(kickstarServiceOwner2.address, `-${ETH_BUDGET}`);

        //     currentProject = await kickstarService.getProjectById(kickstarServiceId);
        //     expect(currentProject.kickstarServiceId).to.equal(kickstarServiceId);
        //     expect(currentProject.paymentToken).to.equal(AddressZero);
        //     expect(currentProject.kickstarServiceOwner).to.equal(kickstarServiceOwner2.address);
        //     expect(currentProject.budget).to.equal(ETH_BUDGET);
        //     expect(currentProject.status).to.be.true;
        //     expect(currentProject.claimPool).not.equal(AddressZero);
        //     expect(await ethers.provider.getBalance(currentProject.claimPool)).to.equal(ETH_BUDGET);

        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel1.address, kickstarServiceId)).rewardPercent).to.equal(3 * 1e3);
        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel1.address, kickstarServiceId)).collectionAddress).to.equal(newHLPeaceGenesisAngel1.address);
        //     expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel1.address)).to.equal(kickstarServiceId);
        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel2.address, kickstarServiceId)).rewardPercent).to.equal(7 * 1e3);
        //     expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel2.address, kickstarServiceId)).collectionAddress).to.equal(newHLPeaceGenesisAngel2.address);
        //     expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel2.address)).to.equal(kickstarServiceId);

        //     claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
        //     expect(await claimPoolContract.kickstarService()).to.equal(kickstarService.address);
        //     expect(await claimPoolContract.paymentToken()).to.equal(AddressZero);
        //     expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel1.address)).to.equal(ETH_BUDGET.mul(3 * 1e3).div(DENOMINATOR));
        //     expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel2.address)).to.equal(ETH_BUDGET.mul(7 * 1e3).div(DENOMINATOR));
        // });
    });

    //   describe("removeProject", () => {
    //     let kickstarServiceId: number;
    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(0)).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId + 1)).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).removeProject(kickstarServiceId)).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId)).to.be.revertedWith("Project deleted");
    //     });

    //     it("should revert with collection has task active", async () => {
    //       const ETH_BUDGET = parseEther("100");
    //       const startTime = (await getTimestamp()) + 1000;
    //       const endTime = startTime + 86400;

    //       await kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId, ETH_BUDGET);

    //       await taskManager.connect(kickstarServiceOwner1).createTask("123", kickstarServiceId, genesis.address, startTime, endTime, ETH_BUDGET);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId)).to.be.revertedWith("Project has an active task. Cannot remove kickstarService");
    //     });

    //     it("it should remove kickstarService successfully", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId))
    //         .to.emit(kickstarService, "RemovedProject")
    //         .withArgs(kickstarServiceId);
    //       let currentProject = await kickstarService.getProjectById(kickstarServiceId);
    //       expect(currentProject.status).to.be.false;

    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, parseUnits("10", 18), collectionInfos);
    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber();
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId))
    //         .to.emit(kickstarService, "RemovedProject")
    //         .withArgs(kickstarServiceId);
    //       currentProject = await kickstarService.getProjectById(kickstarServiceId);
    //       expect(currentProject.status).to.be.false;
    //     });
    //   });

    //   describe("addCollections", () => {
    //     let kickstarServiceId: number;
    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       const collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(0, collectionInfo, [])).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId + 1, collectionInfo, [])).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       const collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       await expect(kickstarService.connect(kickstarServiceOwner2).addCollections(kickstarServiceId, collectionInfo, [])).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with caller is Invalid collection length", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, [], [])).to.be.revertedWith("Invalid collection length");

    //       const maxCollectionInProject = 3;
    //       let collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: user1.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //         {
    //           collectionAddress: kickstarServiceOwner1.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //         {
    //           collectionAddress: kickstarServiceOwner2.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       let percents = [1000,2000,6000,1000];

    //       await kickstarService.setMaxCollectionInProject(maxCollectionInProject);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, percents)).to.be.revertedWith("Invalid collection length");

    //       collectionInfo  = [
    //         {
    //           collectionAddress: user1.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //         {
    //           collectionAddress: kickstarServiceOwner1.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         }
    //       ];
    //       percents = [1000,2000,7000];
    //       await kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, percents);

    //       collectionInfo  = [
    //         {
    //           collectionAddress: user1.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         }
    //       ];
    //       percents = [1000,2000,6000, 1000];
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, percents)).to.be.revertedWith("Invalid collection length");
    //     });

    //     it("should revert with Invalid collection address or collection is already in use", async () => {
    //       const collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000, 5000])).to.be.revertedWith("Invalid collection address or collection is already in use");

    //       collectionInfo[0].collectionAddress = AddressZero;
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000, 5000])).to.be.revertedWith("Invalid collection address or collection is already in use");
    //     });

    //     it("should revert with invalid percents array", async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       const collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 20],
    //         },
    //       ];

    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000])).to.be.revertedWith("Invalid percents array");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000, 5000, 5000])).to.be.revertedWith("Invalid percents array");
    //     });

    //     it("should revert with the total percentage must be equal to 100%", async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       const collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 20],
    //         },
    //       ];

    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000, 3000])).to.be.revertedWith("The total percentage must be equal to 100%");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [5000, 5000])).to.be.revertedWith("The total percentage must be equal to 100%");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId);
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       let collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1200,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [6000, 4000])).to.be.revertedWith("Project deleted");
    //     });

    //     it("should add collection successfully", async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       let collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1200,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [6000, 4000])).to.emit(kickstarService, "AddedCollection");

    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).rewardPercent).to.equal(4000);
    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).collectionAddress).to.equal(newHLPeaceGenesisAngel.address);
    //       expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel.address)).to.equal(kickstarServiceId);

    //       newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       collectionInfo = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1200,
    //           rewardRarityPercents: [],
    //         },
    //       ];

    //       await expect(kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [3000, 4000, 3000])).to.emit(kickstarService, "AddedCollection");

    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).rewardPercent).to.equal(3000);
    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).collectionAddress).to.equal(newHLPeaceGenesisAngel.address);
    //       expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel.address)).to.equal(kickstarServiceId);
    //     });
    //   });

    //   describe("removeCollection", () => {
    //     let kickstarServiceId: number;
    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(0, genesis.address, [])).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId + 1, genesis.address, [])).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).removeCollection(kickstarServiceId, genesis.address, [])).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, genesis.address, [])).to.be.revertedWith("Project deleted");
    //     });

    //     it("should revert with collection has task active", async () => {
    //       const ETH_BUDGET = parseEther("100");
    //       const startTime = (await getTimestamp()) + 1000;
    //       const endTime = startTime + 86400;

    //       await kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId, ETH_BUDGET);

    //       await taskManager.connect(kickstarServiceOwner1).createTask("123", kickstarServiceId, genesis.address, startTime, endTime, ETH_BUDGET);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, genesis.address, [])).to.be.revertedWith("Cannot remove collection");
    //     });

    //     it("should revert with invalid address collection", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, AddressZero, [])).to.be.revertedWith("Invalid collection address");

    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, newHLPeaceGenesisAngel.address, [])).to.be.revertedWith("Invalid collection address");
    //     });

    //     it("should revert with invalid percents array", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, genesis.address, [1200])).to.be.revertedWith("Invalid percents array");
    //     });

    //     it("should revert with the total percentage must be equal to 100%", async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       let collectionInfo: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1200,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];
    //       await kickstarService.connect(kickstarServiceOwner1).addCollections(kickstarServiceId, collectionInfo, [6000, 4000]);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, genesis.address, [1200])).to.be.revertedWith("The total percentage must be equal to 100%");
    //     });

    //     it("should remove collection successfully", async () => {
    //       const BUDGET = parseUnits("400", 18);

    //       // Project 1
    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, genesis.address, []))
    //         .to.emit(kickstarService, "RemovedCollection")
    //         .withArgs(kickstarServiceId, genesis.address);
    //       expect((await kickstarService.collectionInfos(genesis.address, kickstarServiceId)).rewardPercent).to.equal(0);
    //       expect((await kickstarService.collectionInfos(genesis.address, kickstarServiceId)).collectionAddress).to.equal(AddressZero);
    //       expect(await kickstarService.collectionToProjects(genesis.address)).to.equal(0);

    //       let currentProject = await kickstarService.getProjectById(kickstarServiceId);
    //       const provider = ethers.provider;
    //       let claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(genesis.address)).to.equal(0);

    //       // Project 2
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       let newHLPeaceGenesisAngel = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       let collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [],
    //         },
    //       ];

    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber() + 1;
    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, BUDGET, collectionInfos);

    //       await expect(kickstarService.connect(kickstarServiceOwner1).removeCollection(kickstarServiceId, newHLPeaceGenesisAngel.address, []))
    //         .to.emit(kickstarService, "RemovedCollection")
    //         .withArgs(kickstarServiceId, newHLPeaceGenesisAngel.address)
    //         .to.changeTokenBalance(hlpToken, kickstarServiceOwner1.address, BUDGET);

    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).rewardPercent).to.equal(0);
    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel.address, kickstarServiceId)).collectionAddress).to.equal(AddressZero);
    //       expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel.address)).to.equal(0);

    //       currentProject = await kickstarService.getProjectById(kickstarServiceId);
    //       claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel.address)).to.equal(0);

    //       // Project 3
    //       const newHLPeaceGenesisAngel1 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos[0] = {
    //         collectionAddress: newHLPeaceGenesisAngel1.address,
    //         rewardPercent: 3 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       };

    //       const newHLPeaceGenesisAngel2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos.push({
    //         collectionAddress: newHLPeaceGenesisAngel2.address,
    //         rewardPercent: 7 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       });

    //       const ETH_BUDGET = parseEther("100");

    //       kickstarServiceId = (await kickstarService.getProjectCounter()).toNumber() + 1;
    //       await kickstarService.connect(kickstarServiceOwner2).createProject("97", AddressZero, ETH_BUDGET, collectionInfos, {
    //         value: ETH_BUDGET,
    //       });

    //       await expect(kickstarService.connect(kickstarServiceOwner2).removeCollection(kickstarServiceId, newHLPeaceGenesisAngel2.address, [10000]))
    //         .to.emit(kickstarService, "RemovedCollection")
    //         .withArgs(kickstarServiceId, newHLPeaceGenesisAngel2.address)
    //         .to.changeEtherBalance(kickstarServiceOwner2.address, ETH_BUDGET.mul(7 * 1e3).div(DENOMINATOR));

    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel2.address, kickstarServiceId)).rewardPercent).to.equal(0);
    //       expect((await kickstarService.collectionInfos(newHLPeaceGenesisAngel2.address, kickstarServiceId)).collectionAddress).to.equal(AddressZero);
    //       expect(await kickstarService.collectionToProjects(newHLPeaceGenesisAngel2.address)).to.equal(0);

    //       currentProject = await kickstarService.getProjectById(kickstarServiceId);
    //       claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel2.address)).to.equal(0);
    //       expect(await ethers.provider.getBalance(currentProject.claimPool)).to.equal(ETH_BUDGET.mul(3 * 1e3).div(DENOMINATOR));
    //     });
    //   });

    //   describe("deposit", () => {
    //     let kickstarServiceId1: number;
    //     let kickstarServiceId2: number;
    //     const ETH_BUDGET = parseEther("100");
    //     const BUDGET = parseUnits("400", 18);
    //     let newHLPeaceGenesisAngel1: HLPeaceGenesisAngel;
    //     let newHLPeaceGenesisAngel2: HLPeaceGenesisAngel;
    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();

    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       newHLPeaceGenesisAngel1 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos[0] = {
    //         collectionAddress: newHLPeaceGenesisAngel1.address,
    //         rewardPercent: 3 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       };

    //       newHLPeaceGenesisAngel2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos.push({
    //         collectionAddress: newHLPeaceGenesisAngel2.address,
    //         rewardPercent: 7 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       });

    //       kickstarServiceId2 = (await kickstarService.getProjectCounter()).toNumber() + 1;
    //       await kickstarService.connect(kickstarServiceOwner2).createProject("97", AddressZero, ETH_BUDGET, collectionInfos, {
    //         value: ETH_BUDGET,
    //       });
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).deposit(0, 200)).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId1 + 123, 200)).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).deposit(kickstarServiceId1, 200)).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with invalid amount", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId1, 0)).to.be.revertedWith("Invalid amount");
    //       await expect(
    //         kickstarService.connect(kickstarServiceOwner2).deposit(kickstarServiceId2, 100, {
    //           value: ETH_BUDGET,
    //         })
    //       ).to.be.revertedWith("Invalid amount");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId1, BUDGET)).to.be.revertedWith("Project deleted");
    //     });

    //     it("should deposit successfully", async () => {
    //       // Project 1
    //       let currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).deposit(kickstarServiceId1, BUDGET))
    //         .to.emit(kickstarService, "Deposited")
    //         .withArgs(kickstarServiceId1, BUDGET)
    //         .to.changeTokenBalances(hlpToken, [kickstarServiceOwner1, currentProject.claimPool], [`-${BUDGET}`, BUDGET]);

    //       const provider = ethers.provider;
    //       let claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(genesis.address)).to.equal(BUDGET);

    //       currentProject = await kickstarService.getProjectById(kickstarServiceId2);
    //       await expect(
    //         kickstarService.connect(kickstarServiceOwner2).deposit(kickstarServiceId2, ETH_BUDGET.div(2), {
    //           value: ETH_BUDGET.div(2),
    //         })
    //       )
    //         .to.emit(kickstarService, "Deposited")
    //         .withArgs(kickstarServiceId1, BUDGET)
    //         .to.changeEtherBalances([kickstarServiceOwner2, currentProject.claimPool], [`-${ETH_BUDGET.div(2)}`, ETH_BUDGET.div(2)]);

    //       claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel1.address)).to.equal(parseEther("45"));
    //       expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel2.address)).to.equal(parseEther("105"));
    //     });
    //   });

    //   describe("depositToCollection", () => {
    //     let kickstarServiceId1: number;
    //     let kickstarServiceId2: number;
    //     const ETH_BUDGET = parseEther("100");
    //     const BUDGET = parseUnits("400", 18);
    //     let newHLPeaceGenesisAngel1: HLPeaceGenesisAngel;
    //     let newHLPeaceGenesisAngel2: HLPeaceGenesisAngel;

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();

    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       newHLPeaceGenesisAngel1 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos[0] = {
    //         collectionAddress: newHLPeaceGenesisAngel1.address,
    //         rewardPercent: 3 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       };

    //       newHLPeaceGenesisAngel2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       collectionInfos.push({
    //         collectionAddress: newHLPeaceGenesisAngel2.address,
    //         rewardPercent: 7 * 1e3,
    //         rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //       });

    //       kickstarServiceId2 = (await kickstarService.getProjectCounter()).toNumber() + 1;
    //       await kickstarService.connect(kickstarServiceOwner2).createProject("97", AddressZero, ETH_BUDGET, collectionInfos, {
    //         value: ETH_BUDGET,
    //       });
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(0, genesis.address, 200)).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1 + 123, genesis.address, 200)).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).depositToCollection(kickstarServiceId1, genesis.address, 200)).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with invalid address", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1, AddressZero, 200)).to.be.revertedWith("Invalid address");
    //     });

    //     it("should revert with invalid amount", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1, genesis.address, 0)).to.be.revertedWith("Invalid amount");
    //       await expect(
    //         kickstarService.connect(kickstarServiceOwner2).depositToCollection(kickstarServiceId2, newHLPeaceGenesisAngel1.address, 100, {
    //           value: ETH_BUDGET,
    //         })
    //       ).to.be.revertedWith("Invalid amount");
    //     });

    //     it("should revert with invalid collection address", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1, user1.address, BUDGET)).to.be.revertedWith("Invalid collection address");

    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1, genesis.address, BUDGET)).to.be.revertedWith("Invalid collection address");
    //     });

    //     it("should revert with invalid collection address", async () => {
    //       await expect(
    //         kickstarService.connect(kickstarServiceOwner2).depositToCollection(kickstarServiceId2, genesis.address, ETH_BUDGET, {
    //           value: ETH_BUDGET,
    //         })
    //       ).to.be.revertedWith("Invalid collection address");
    //     });

    //     it("should depositToCollection successfully", async () => {
    //       // Project 1
    //       let currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).depositToCollection(kickstarServiceId1, genesis.address, BUDGET))
    //         .to.emit(kickstarService, "DepositedToCollection")
    //         .withArgs(kickstarServiceId1, genesis.address, BUDGET)
    //         .to.changeTokenBalances(hlpToken, [kickstarServiceOwner1, currentProject.claimPool], [`-${BUDGET}`, BUDGET]);

    //       const provider = ethers.provider;
    //       let claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(genesis.address)).to.equal(BUDGET);

    //       currentProject = await kickstarService.getProjectById(kickstarServiceId2);
    //       await expect(
    //         kickstarService.connect(kickstarServiceOwner2).depositToCollection(kickstarServiceId2, newHLPeaceGenesisAngel1.address, ETH_BUDGET.div(2), {
    //           value: ETH_BUDGET.div(2),
    //         })
    //       )
    //         .to.emit(kickstarService, "DepositedToCollection")
    //         .withArgs(kickstarServiceId1, newHLPeaceGenesisAngel1.address, BUDGET)
    //         .to.changeEtherBalances([kickstarServiceOwner2, currentProject.claimPool], [`-${ETH_BUDGET.div(2)}`, ETH_BUDGET.div(2)]);

    //       claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(newHLPeaceGenesisAngel1.address)).to.equal(parseEther("80"));
    //     });
    //   });

    //   describe("updatePercent", () => {
    //     let kickstarServiceId1: number;
    //     const ETH_BUDGET = parseEther("100");
    //     const BUDGET = parseUnits("400", 18);

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(0, [200])).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(kickstarServiceId1 + 123, [200])).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).updatePercent(kickstarServiceId1, [])).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(kickstarServiceId1, [])).to.be.revertedWith("Project deleted");
    //     });

    //     it("should revert with the total percent must be equal to 100%", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(kickstarServiceId1, [])).to.be.revertedWith("The total percentage must be equal to 100%");
    //     });

    //     it("should revert with invalid length", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(kickstarServiceId1, [3000, 7000])).to.be.revertedWith("Invalid length");
    //     });

    //     it("should updatePercent successfully", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(kickstarServiceId1, [10000])).to.emit(kickstarService, "UpdatedPercent");
    //     });

    //     it("should revert with invalid kickstarService", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updatePercent(0, [])).to.be.revertedWith("Invalid kickstarServiceId");
    //     });
    //   });

    //   describe("updateRewardRarityPercent", () => {
    //     let kickstarServiceId1: number;
    //     const ETH_BUDGET = parseEther("100");
    //     const BUDGET = parseUnits("400", 18);

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(0, genesis.address, [200])).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(kickstarServiceId1 + 123, genesis.address, [200])).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).updateRewardRarityPercent(kickstarServiceId1, genesis.address, [])).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with kickstarService deleted", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(kickstarServiceId1, genesis.address, [])).to.be.revertedWith("Project deleted");
    //     });

    //     it("should revert with the total percent must be equal to 100%", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(kickstarServiceId1, genesis.address, [])).to.be.revertedWith("The total percentage must be equal to 100%");
    //     });

    //     it("should revert with invalid collection address", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(kickstarServiceId1, ZERO_ADDRESS, [2000, 3000, 5000])).to.be.revertedWith("Invalid collection address");
    //     });

    //     it("should updateRewardRarityPercent successfully", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).updateRewardRarityPercent(kickstarServiceId1, genesis.address, [2000, 3000, 5000])).to.emit(kickstarService, "UpdatedRewardRarityPercent");
    //     });
    //   });

    //   describe("splitBudget", () => {
    //     let kickstarServiceId1: number;
    //     const BUDGET = parseUnits("400", 18);

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.splitBudget(kickstarServiceId1 + 1, BUDGET)).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not permitted", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner2).splitBudget(kickstarServiceId1, BUDGET)).to.be.revertedWith("Caller is not permitted");
    //     });

    //     it("it should splitBudget successfully", async () => {
    //       await hlpToken.connect(kickstarServiceOwner1).transfer(hlpClaimPool.address, BUDGET);

    //       const currentProject = await kickstarService.getProjectById(kickstarServiceId1);

    //       await expect(hlpClaimPool.connect(admin).depositToProject(kickstarServiceId1, BUDGET))
    //         .to.emit(kickstarService, "SplittedBudget")
    //         .withArgs(kickstarServiceId1, BUDGET)
    //         .to.changeTokenBalances(hlpToken, [hlpClaimPool, currentProject.claimPool], [`-${BUDGET}`, BUDGET]);

    //       const provider = ethers.provider;
    //       let claimPoolContract = new ethers.Contract(currentProject.claimPool, ClaimPoolJSON.abi, provider);
    //       expect(await claimPoolContract.collectionClaimPool(genesis.address)).to.equal(BUDGET);
    //     });
    //   });

    //   describe("setRewardAddress", () => {
    //     let kickstarServiceId1: number;

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with caller is not owner", async () => {
    //       await expect(kickstarService.connect(user1).setRewardAddress(ZERO_ADDRESS)).to.rejectedWith("Ownable: caller is not the owner");
    //     });

    //     it("should revert with invalid address", async () => {
    //       await expect(kickstarService.setRewardAddress(ZERO_ADDRESS)).to.rejectedWith("Invalid address");
    //     });

    //     it("should revert with rewardAddress already exists", async () => {
    //       await expect(kickstarService.setRewardAddress(reward.address)).to.rejectedWith("RewardAddress already exists");
    //     });

    //     it("should setRewardAddress successfully", async () => {
    //       const Admin: Admin__factory = await ethers.getContractFactory("Admin");
    //       const admin: Admin = (await upgrades.deployProxy(Admin, [owner.address])) as Admin;
    //       await admin.deployed();

    //       const Reward: Reward__factory = await ethers.getContractFactory("Reward");
    //       const newReward = (await upgrades.deployProxy(Reward, [admin.address])) as Reward;

    //       await expect(kickstarService.setRewardAddress(newReward.address))
    //         .to.emit(kickstarService, "SetRewardAddress")
    //         .withArgs(reward.address, newReward.address);
    //     });
    //   });

    //   describe("withdrawCollection", () => {
    //     let kickstarServiceId1: number;
    //     const ETH_BUDGET = parseEther("100");
    //     let newHLPeaceGenesisAngel1: HLPeaceGenesisAngel;
    //     let newHLPeaceGenesisAngel2: HLPeaceGenesisAngel;

    //     beforeEach(async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       newHLPeaceGenesisAngel1 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       newHLPeaceGenesisAngel2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 5 * 1e3,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel1.address,
    //           rewardPercent: 3 * 1e3,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //         {
    //           collectionAddress: newHLPeaceGenesisAngel2.address,
    //           rewardPercent: 2 * 1e3,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", AddressZero, ETH_BUDGET, collectionInfos, {
    //         value: ETH_BUDGET,
    //       });
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should revert with invalid kickstarServiceId", async () => {
    //       await expect(kickstarService.connect(user1).withdrawCollection(0, genesis.address, ETH_BUDGET)).to.be.revertedWith("Invalid kickstarServiceId");
    //       await expect(kickstarService.connect(user1).withdrawCollection(kickstarServiceId1 + 1, genesis.address, ETH_BUDGET)).to.be.revertedWith("Invalid kickstarServiceId");
    //     });

    //     it("should revert with caller is not kickstarService owner", async () => {
    //       await expect(kickstarService.connect(user1).withdrawCollection(kickstarServiceId1, genesis.address, ETH_BUDGET)).to.be.revertedWith("Caller is not kickstarService owner");
    //     });

    //     it("should revert with invalid address", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, ZERO_ADDRESS, ETH_BUDGET)).to.be.revertedWith("Invalid address");
    //     });

    //     it("should revert with invalid amount", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, genesis.address, 0)).to.be.revertedWith("Invalid amount");
    //     });

    //     it("should revert with invalid colletion address", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, user1.address, 1000)).to.be.revertedWith("Invalid collection address");
    //     });

    //     it("should revert with invalid amount because of not enough budget", async () => {
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, genesis.address, ETH_BUDGET.add(1))).to.be.revertedWith("Invalid amount");
    //     });

    //     it("should revert with Amount exceeds balance", async () => {
    //       const currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, genesis.address, ETH_BUDGET)).to.be.revertedWith("Amount exceeds balance");
    //     });

    //     it("should withdrawCollection succesfully", async () => {
    //       const currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, genesis.address, ETH_BUDGET.div(4)))
    //         .to.emit(kickstarService, "WithdrawnCollection")
    //         .withArgs(kickstarServiceId1, genesis.address, ETH_BUDGET.div(4))
    //         .to.changeEtherBalances([currentProject.claimPool, kickstarServiceOwner1.address], [`-${ETH_BUDGET.div(4)}`, ETH_BUDGET.div(4)]);

    //       await expect(kickstarService.connect(kickstarServiceOwner1).withdrawCollection(kickstarServiceId1, newHLPeaceGenesisAngel1.address, ETH_BUDGET.div(5)))
    //         .to.emit(kickstarService, "WithdrawnCollection")
    //         .withArgs(kickstarServiceId1, newHLPeaceGenesisAngel1.address, ETH_BUDGET.div(5))
    //         .to.changeEtherBalances([currentProject.claimPool, kickstarServiceOwner1.address], [`-${ETH_BUDGET.div(5)}`, ETH_BUDGET.div(5)]);
    //     });
    //   });

    //   describe("isProjectActive", () => {
    //     let kickstarServiceId1: number;

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, 0, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should isProjectActive return false", async () => {
    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       expect(await kickstarService.isProjectActive(kickstarServiceId1)).to.be.false;
    //     });

    //     it("should isProjectActive return true", async () => {
    //       expect(await kickstarService.isProjectActive(kickstarServiceId1)).to.be.true;
    //     });
    //   });

    //   describe("View function", () => {
    //     let kickstarServiceId1: number;
    //     const BUDGET = parseUnits("400", 18);

    //     beforeEach(async () => {
    //       const collectionInfos: CollectionInfoStruct[] = [
    //         {
    //           collectionAddress: genesis.address,
    //           rewardPercent: 1e4,
    //           rewardRarityPercents: [7208, 2520, 252, 18, 2],
    //         },
    //       ];

    //       await kickstarService.connect(kickstarServiceOwner1).createProject("97", hlpToken.address, BUDGET, collectionInfos);
    //       kickstarServiceId1 = (await kickstarService.getProjectCounter()).toNumber();
    //     });

    //     it("should getProjectCounter return kickstarServiceId", async () => {
    //       expect(await kickstarService.getProjectCounter()).to.equal(kickstarServiceId1);
    //     });

    //     it("should getProjectById successfully", async () => {
    //       const currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       expect(currentProject.kickstarServiceId).to.equal(kickstarServiceId1);
    //       expect(currentProject.paymentToken).to.equal(hlpToken.address);
    //       expect(currentProject.kickstarServiceOwner).to.equal(kickstarServiceOwner1.address);
    //       expect(currentProject.budget).to.equal(BUDGET);
    //       expect(currentProject.status).to.be.true;
    //       expect(currentProject.claimPool).not.equal(AddressZero);
    //     });

    //     it("should getLengthCollectionByProjectId successfully", async () => {
    //       expect(await kickstarService.getLengthCollectionByProjectId(kickstarServiceId1)).to.equal(1);
    //     });

    //     it("should getCollectionByIndex successfully", async () => {
    //       expect(await kickstarService.getCollectionByIndex(kickstarServiceId1, 0)).to.equal(genesis.address);
    //     });

    //     it("should getPaymentTokenOf successfully", async () => {
    //       expect(await kickstarService.getPaymentTokenOf(genesis.address)).to.equal(hlpToken.address);
    //     });

    //     it("should getClaimPoolOf successfully", async () => {
    //       const currentProject = await kickstarService.getProjectById(kickstarServiceId1);
    //       expect(await kickstarService.getClaimPoolOf(genesis.address)).to.equal(currentProject.claimPool);
    //     });

    //     it("should isCollectionActive return false/true", async () => {
    //       expect(await kickstarService.isCollectionActive(ZERO_ADDRESS)).to.be.false;
    //       expect(await kickstarService.isCollectionActive(genesis.address)).to.be.true;
    //     });

    //     it("should getAllCollection successfully", async () => {
    //       expect((await kickstarService.getAllCollection(kickstarServiceId1)).length).to.equal(1);
    //     });

    //     it("should getRewardRarityPercents successfully", async () => {
    //       // [7208, 2520, 252, 18, 2]
    //       const inputRariryPercents = [7208, 2520, 252, 18, 2];
    //       const rarityPercents = await kickstarService.getRewardRarityPercents(kickstarServiceId1, genesis.address);
    //       expect(rarityPercents[0]).to.equal(inputRariryPercents[0]);
    //       expect(rarityPercents[1]).to.equal(inputRariryPercents[1]);
    //       expect(rarityPercents[2]).to.equal(inputRariryPercents[2]);
    //       expect(rarityPercents[3]).to.equal(inputRariryPercents[3]);
    //     })

    //     it("should getProjectOwnerOf successful", async () => {
    //       let kickstarServiceOwner = await kickstarService.getProjectOwnerOf(genesis.address);
    //       expect(kickstarServiceOwner).to.equal(kickstarServiceOwner1.address);

    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       const genesis2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;
    //       kickstarServiceOwner = await kickstarService.getProjectOwnerOf(genesis2.address);
    //       expect(kickstarServiceOwner).to.equal(ZERO_ADDRESS);
    //     });

    //     it("should getRewardOf successful", async () => {
    //       const HLPeaceGenesisAngel: HLPeaceGenesisAngel__factory = await ethers.getContractFactory("HLPeaceGenesisAngel");
    //       const genesis2 = (await HLPeaceGenesisAngel.deploy(owner.address, owner.address,  "HLPeaceGenesisAngel NFT", "NFT", "BASE_URI", "abc", treasury.address, FEE_NUMERATOR, 5000, METADATA)) as HLPeaceGenesisAngel;

    //       let reward = await kickstarService.getRewardOf(genesis2.address);
    //       expect(reward).to.equal(0);

    //       reward = await kickstarService.getRewardOf(genesis.address)
    //       expect(reward).to.equal(BUDGET);

    //       await kickstarService.connect(kickstarServiceOwner1).removeProject(kickstarServiceId1);
    //       reward = await kickstarService.getRewardOf(genesis.address)
    //       expect(reward).to.equal(0);
    //     });

    //   });
});
