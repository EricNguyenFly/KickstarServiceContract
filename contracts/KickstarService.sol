// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./lib/Helper.sol";
import "./interfaces/IReferral.sol";

contract KickstarService is PausableUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    //  prettier-ignore
    /*
     *  @dev Project struct
     */
    struct Project {
        address         freelancer;               // Freelancer of project
        address         client;                   // Client of project
        address         paymentToken;             // Project token using in Project
        ProjectStatus   status;                   // Project's status
        uint256         budget;                   // Amount of all milestone
        uint256         amountPaid;               // The amount paid
        uint256         amountClaimAccepted;      // The amount to accepted to claim
        uint256         amountClientFee;          // The tax amount
        uint256         currentMilestone;         // Current milestone
        uint256         createdDate;              // Project's created day
        uint256         expiredDate;              // Project's expired day
        uint256         lastClaimId;              // Id of this milestone last claim
        uint256[]       milestoneBudgets;         // List of budget of milestones
        uint256         clientFeePercent;         // Client fee percent
		uint256         freelancerFeePercent;     // Freelancer fee percent
        PayType         payType;                  // Type of pay
    }

    //  prettier-ignore
    /*
     *  @dev Milestone struct is information of milestone includes: created date, paid date, status
     */
    struct Milestone {
        uint256 projectId;                  // Id of project
		uint256 amount;                     // Milestone's active date
        MilestoneStatus status;             // Milestone status
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                           Value
     *           |                               |
     *  Pay all                                 ALL
     *  Pay in milestone                        MILESTONE
     */
    enum PayType {
        ALL,
        MILESTONE
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                                              Value
     *           |                                                  |
     *  When project is still in processing                     PROCESSING
     *  After the last milestone is completed                   FINISHED
     *  After Client stop project                               STOPPED
     */
    enum ProjectStatus {
        PROCESSING,
        FINISHED,
        STOPPED
    }

    /**
     *  MilestoneStatus enum is status of per milestone
     *
     *          Suit                                                                        Value
     *           |                                                                             |
     *  Default milestone status                                                            CREATED
     *  After Client confirm to release money                                               ACCEPTED
     *  After Freelancer claim milestone                                                    CLAIMED
     *  After Client not provide service on time and fund is refunded to Freelancer         CANCELED
     */
    enum MilestoneStatus {
        CREATED,
        PAID,
        ACCEPTED,
        CLAIMED,
        CANCELED
    }

    uint256 public constant FEE_DENOMINATOR = 10000;

    /**
     *  @dev this is contract referral
     */
    IReferral public referral;

    /**
     *  @dev maxMilestone uint256 is max qty milestone of each project
     */
    uint256 public maxMilestone;

    /**
     *  @dev serviceFee uint256 is service fee of each project
     */
    uint256 public clientFeePercent;
    uint256 public freelancerFeePercent;

    /**
     *  @dev lastProjectId uint256 is the latest requested project ID started by 1
     */
    uint256 public lastProjectId;

    /**
     *  @dev Mapping project ID to a project detail
     */
    mapping(uint256 => Project) public projects;

    /**
     *  @dev Mapping project ID to milestone ID to get info of per milestone
     */
    mapping(uint256 => mapping(uint256 => Milestone)) private milestones;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => bool) public permittedPaymentTokens;

    event AcceptBid(
        uint256 indexed projectId,
        address freelancer,
        address client,
        address paymentToken,
        uint256 budget,
        uint256 createdDate,
        uint256 expiredDate,
        ProjectStatus milestoneStatus,
        PayType payType,
        uint256[] milestoneBudgets
    );
    event Deposited(
        uint256 indexed projectId,
        uint256 indexed milestoneId,
        uint256 totalAmount,
        ProjectStatus projectStatus
    );
    event ClientConfirmMilestone(uint256 indexed projectId, uint256 indexed milestoneId, bool isDepositNextMilestone);
    event Claimed(
        uint256 indexed projectId,
        address indexed client,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
        ProjectStatus projectStatus
    );
    event Judged(
        uint256 indexed projectId,
        uint256 indexed currentMilestoneId,
        bool indexed isCancel,
        ProjectStatus projectStatus
    );
    event Toggled(bool isPaused);

    event SetServiceFeePercent(
        uint256 oldClientFeePercent,
        uint256 oldFreelancerFeePercent,
        uint256 newClientFeePercent,
        uint256 newFreelancerFeePercent
    );
    event SetPermittedToken(address indexed token, bool indexed allowed);
    event SetMaxMilestone(uint256 oldValue, uint256 newValue);
    event SetReferralContract(address indexed oldValue, address indexed newValue);

    modifier notZeroAddress(address _addr) {
        require(_addr != address(0), "Invalid address");
        _;
    }

    modifier onlyFreelancer(uint256 _projectId) {
        require(_msgSender() == projects[_projectId].freelancer, "Caller is not the freelancer of this project");
        _;
    }

    modifier onlyClient(uint256 _projectId) {
        require(_msgSender() == projects[_projectId].client, "Caller is not the Client of this project");
        _;
    }

    modifier onlyValidProject(uint256 _projectId) {
        require(_projectId > 0 && _projectId <= lastProjectId, "Invalid project id");
        _;
    }

    modifier onlyNonExpiredProject(uint256 _projectId) {
        require(block.timestamp <= projects[_projectId].expiredDate, "Project is expired");
        _;
    }

    /**
     *  @dev Initialize new contract.
     */
    function initialize(address _owner, IReferral _referral) public initializer {
        __Pausable_init();
        __Ownable_init();
        __ReentrancyGuard_init();

        referral = _referral;
        maxMilestone = 10;
        clientFeePercent = 1500;
        freelancerFeePercent = 500;

        transferOwnership(_owner);
        _pause();
    }

    // -----------External Functions-----------

    /**
     *  @dev    Toggle contract interupt
     *
     *  @notice Only owner can execute this function
     */
    function toggle() external onlyOwner {
        if (paused()) {
            _unpause();
        } else {
            _pause();
        }

        emit Toggled(paused());
    }

    /**
     *  @dev    Set permitted token for project
     *
     *  @notice Only Owner (KickstarService) can call this function.
     *
     *          Name            Meaning
     *  @param  _paymentToken    Address of token that needs to be permitted
     *  @param  _allowed         Allow or not to pay with this token
     *
     *  Emit event {SetPermittedToken}
     */
    function setPermittedToken(address _paymentToken, bool _allowed) external whenNotPaused onlyOwner {
        permittedPaymentTokens[_paymentToken] = _allowed;
        emit SetPermittedToken(_paymentToken, _allowed);
    }

    /**
     *  @dev    Set service fee percentage
     *
     *  @notice Only owner can call this function.
     *
     *          Name            Meaning
     *  @param  _clientFeePercent        		New client fee percent that want to be updated
     *  @param  _freelancerFeePercent        	New freelance fee percent that want to be updated
     *
     *  Emit event {SetServiceFeePercent}
     */
    function setServiceFeePercent(
        uint256 _clientFeePercent,
        uint256 _freelancerFeePercent
    ) external whenNotPaused onlyOwner {
        require(
            _clientFeePercent > 0 &&
                _freelancerFeePercent > 0 &&
                _clientFeePercent <= FEE_DENOMINATOR &&
                _freelancerFeePercent <= FEE_DENOMINATOR,
            "Invalid service fee percent"
        );

        uint256 oldClientFeePercent = clientFeePercent;
        uint256 oldFreelancerFeePercent = freelancerFeePercent;
        clientFeePercent = _clientFeePercent;
        freelancerFeePercent = _freelancerFeePercent;
        emit SetServiceFeePercent(oldClientFeePercent, oldFreelancerFeePercent, clientFeePercent, freelancerFeePercent);
    }

    /**
     * @notice Set max milestone
     *
     * @dev    Only owner can call this function.
     *
     * @param  _maxMilestone   Number of milestone.
     *
     * emit {SetMaxMilestone} events
     */
    function setMaxMilestone(uint256 _maxMilestone) external whenNotPaused onlyOwner {
        require(_maxMilestone > 0, "Invalid maxMilestone");
        uint256 oldValue = maxMilestone;
        maxMilestone = _maxMilestone;
        emit SetMaxMilestone(oldValue, maxMilestone);
    }

    /**
     * @notice Set referral contract
     *
     * @dev    Only owner can call this function.
     *
     * @param  _referral   Contract referral.
     *
     * emit {SetReferralContract} events
     */
    function setReferralContract(address _referral) external whenNotPaused onlyOwner notZeroAddress(_referral) {
        require(_referral != address(referral), "Already exist");
        address oldValue = address(referral);
        referral = IReferral(_referral);
        emit SetReferralContract(oldValue, _referral);
    }

    /**
     *  @dev    Create a new project
     *
     *  @notice Anyone can call this function.
     *
     *          Name                        Meaning
     *  @param  _freelancer                 Address of client
     *  @param  _paymentToken               Token contract address
     *  @param  _budget                     Total amount of project
     *  @param  _milestoneBudgets           Array of budget per installment of project
     *  @param  _expiredDate                Project's expired date
     *  @param  _payType                    Type of pay
     *
     *  Emit event {AcceptBid}
     */
    function acceptBid(
        address _freelancer,
        address _paymentToken,
        uint256 _budget,
        uint256 _expiredDate,
        uint256[] memory _milestoneBudgets,
        PayType _payType
    ) external payable whenNotPaused notZeroAddress(_freelancer) {
        require(_msgSender() != _freelancer, "Freelancer can not be same");
        require(permittedPaymentTokens[_paymentToken] || _paymentToken == address(0), "Invalid payment token");
        require(_budget > 0, "Budget must be greater than 0");
        require(_milestoneBudgets.length > 0 && _milestoneBudgets.length <= maxMilestone, "Invalid length");

        uint256 currentTime = block.timestamp;
        require(_expiredDate > currentTime, "Invalid expired date");

        lastProjectId++;
        Project storage project = projects[lastProjectId];
        project.client = _msgSender();
        project.freelancer = _freelancer;
        project.paymentToken = _paymentToken;
        project.budget = _budget;
        project.milestoneBudgets = _milestoneBudgets;
        project.createdDate = currentTime;
        project.expiredDate = _expiredDate;
        project.payType = _payType;

        uint256 _disscountClientFeePercent = referral.getReferrer(_msgSender());
        uint256 _disscountFreelancerFeePercent = referral.getReferrer(_freelancer);

        project.clientFeePercent = _disscountClientFeePercent < clientFeePercent
            ? clientFeePercent - _disscountClientFeePercent
            : 0;
        project.freelancerFeePercent = _disscountFreelancerFeePercent < freelancerFeePercent
            ? freelancerFeePercent - _disscountFreelancerFeePercent
            : 0;

        uint256 _totalValue = 0;

        for (uint256 i = 0; i < _milestoneBudgets.length; i++) {
            require(_milestoneBudgets[i] > 0, "Invalid amount of milestone");
            _totalValue += _milestoneBudgets[i];
        }
        require(_totalValue == _budget, "Invalid total amount");

        project.currentMilestone++;
        milestones[lastProjectId][project.currentMilestone] = Milestone(
            lastProjectId,
            _milestoneBudgets[0],
            MilestoneStatus.PAID
        );

        if (_payType == PayType.ALL) {
            project.amountPaid = _budget;
        } else {
            project.amountPaid = _milestoneBudgets[0];
        }

        uint256 _clientFee = calculateServiceFee(project.amountPaid, clientFeePercent);
        project.amountClientFee += _clientFee;
        _deposit(project.paymentToken, _msgSender(), project.amountPaid + project.amountClientFee);

        emit AcceptBid(
            lastProjectId,
            _freelancer,
            _msgSender(),
            _paymentToken,
            _budget,
            currentTime,
            _expiredDate,
            project.status,
            _payType,
            _milestoneBudgets
        );
    }

    /**
     *  @dev    If current milestone is ACCEPT or CLAIMED and next milestone has not been paid so client can pay next current milestone of project
     *
     *  @notice Only Client can call this function.
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that needs to be updated
     *
     *  Emit event {Deposited}
     */
    function depositToContinueProject(
        uint256 _projectId
    )
        external
        payable
        whenNotPaused
        onlyValidProject(_projectId)
        onlyNonExpiredProject(_projectId)
        onlyClient(_projectId)
        nonReentrant
    {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project isn't processing");

        uint256 _milestoneId = project.currentMilestone;
        require(_milestoneId < project.milestoneBudgets.length, "No milestone to deposit");
        Milestone storage milestone = milestones[_projectId][_milestoneId];
        require(
            milestone.status == MilestoneStatus.ACCEPTED || milestone.status == MilestoneStatus.CLAIMED,
            "Invalid milestone"
        );
        (uint256 _milestoneIdNext, uint256 _amount) = _createMilestone(_projectId, project);

        emit Deposited(_projectId, _milestoneIdNext, _amount, project.status);
    }

    /**
     *  @dev    Client confirm that provides service to Client
     *
     *  @notice Only Client can call this function.
     *
     *          Name        Meaning
     *  @param  _projectId  ID of project that needs to be updated
     *
     *  Emit event {ClientConfirmMilestone}
     */
    function clientConfirmMilestone(
        uint256 _projectId,
        bool _isDepositNextMilestone
    )
        external
        payable
        whenNotPaused
        onlyValidProject(_projectId)
        onlyNonExpiredProject(_projectId)
        onlyClient(_projectId)
    {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project isn't processing");
        uint256 _milestoneId = project.currentMilestone;
        Milestone storage milestone = milestones[_projectId][_milestoneId];
        require(milestone.status == MilestoneStatus.PAID, "This milestone has not been paid by client");
        project.amountClaimAccepted += milestone.amount;
        milestone.status = MilestoneStatus.ACCEPTED;

        if (_isDepositNextMilestone && _milestoneId < project.milestoneBudgets.length) {
            _createMilestone(_projectId, project);
        }

        emit ClientConfirmMilestone(_projectId, _milestoneId, _isDepositNextMilestone);
    }

    /**
     *  @dev    Freelancer claim all milestones of project
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name          Meaning
     *  @param  _projectId    ID of project want to claim all milestones
     *
     *  Emit event {Claimed}
     */
    function claim(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyFreelancer(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        uint256 _claimableTotalAmount = 0;
        uint256 _nextLastClaimId = project.lastClaimId;
        // Set CLAIMED status for claimed milestone
        for (uint256 i = project.lastClaimId + 1; i <= project.currentMilestone; ++i) {
            Milestone storage milestone = milestones[_projectId][i];
            if (milestone.status == MilestoneStatus.ACCEPTED) {
                _nextLastClaimId = i;
                _claimableTotalAmount += milestone.amount;
                milestone.status = MilestoneStatus.CLAIMED;
            }
        }
        require(_nextLastClaimId > project.lastClaimId, "Nothing to claim");
        project.lastClaimId = _nextLastClaimId;

        uint256 _serviceFeeClient = 0;
        if (project.lastClaimId == project.milestoneBudgets.length) {
            project.status = ProjectStatus.FINISHED;
            _serviceFeeClient = project.amountClientFee;
        }

        // Calculate fee and transfer tokens
        uint256 _serviceFee = calculateServiceFee(_claimableTotalAmount, project.freelancerFeePercent);
        uint256 _claimableAmount = _claimableTotalAmount - _serviceFee;

        _withdraw(_msgSender(), project.paymentToken, _claimableAmount);
        _withdraw(owner(), project.paymentToken, _serviceFee + _serviceFeeClient);

        emit Claimed(_projectId, _msgSender(), project.paymentToken, _claimableAmount, _serviceFee, project.status);
    }

    /**
     *  @dev    Judge for client and freelancer if they have conflict
     *
     *  @notice Only Owner (KickstarService) can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that Owner (KickstarService) want to handle
     *  @param  _isStop             true -> Client win -> cancel this milestone and project; false -> Freelancer win -> force client to confirm this milestone
     *
     *  Emit event {Judged}
     */
    function judge(
        uint256 _projectId,
        bool _isStop
    ) external whenNotPaused onlyValidProject(_projectId) onlyOwner nonReentrant {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project hasn't been processing yet");

        Milestone storage milestone = milestones[_projectId][project.currentMilestone];

        if (_isStop) {
            if (milestone.status == MilestoneStatus.PAID) {
                milestone.status = MilestoneStatus.CANCELED;
            }

            project.status == ProjectStatus.STOPPED;
            uint256 _amountRefund = project.amountPaid - project.amountClaimAccepted + project.amountClientFee;
            _withdraw(project.client, project.paymentToken, _amountRefund);
        } else {
            require(milestone.status == MilestoneStatus.PAID, "Milestone hasn't confirm yet");
            project.amountClaimAccepted += milestone.amount;
            milestone.status = MilestoneStatus.ACCEPTED;
        }

        emit Judged(_projectId, project.currentMilestone, _isStop, project.status);
    }

    /**
     *  @dev    Calculate service fee by amount project
     *
     *  @notice Service fee equal amount of project mutiply serviceFeePercent. The actual service fee will be divided by WEIGHT_DECIMAL and 100
     *
     *          Name                Meaning
     *  @param  _amount             Amount of service fee that want to withdraw
     *  @param  _serviceFeePercent  Service fee percent
     *
     *  @return Caculated service fee from the amount of token
     */
    function calculateServiceFee(uint256 _amount, uint256 _serviceFeePercent) public pure returns (uint256) {
        return (_amount * _serviceFeePercent) / FEE_DENOMINATOR;
    }

    /**
     *  @dev    Get pending milestone ids that waiting for Freelancer claim from project by project id
     *
     *          Name                Meaning
     *  @param  _projectId          Project id
     *  @param  _mileStoneId        Milestone id
     *
     */
    function getMilestoneById(uint256 _projectId, uint256 _mileStoneId) external view returns (Milestone memory) {
        Project storage project = projects[_projectId];
        if (_projectId > 0 && _projectId <= lastProjectId) {
            if (_mileStoneId > 0 && _mileStoneId <= project.currentMilestone) {
                return milestones[_projectId][_mileStoneId];
            } else if (_mileStoneId > project.currentMilestone && _mileStoneId <= project.milestoneBudgets.length) {
                if (project.payType == PayType.ALL) {
                    return Milestone(_projectId, project.milestoneBudgets[_mileStoneId - 1], MilestoneStatus.PAID);
                }
                return Milestone(_projectId, project.milestoneBudgets[_mileStoneId - 1], MilestoneStatus.CREATED);
            }
        }

        return Milestone(0, 0, MilestoneStatus.CREATED);
    }

    /**
     *  @dev    Create milestone
     *
     *          Name                Meaning
     *  @param  _projectId          Id of project
     *  @param  _project            Info of project
     */
    function _createMilestone(
        uint256 _projectId,
        Project storage _project
    ) private returns (uint256 _milestoneIdNext, uint256 _amount) {
        _project.currentMilestone++;
        _milestoneIdNext = _project.currentMilestone;
        _amount = _project.milestoneBudgets[_milestoneIdNext - 1];
        milestones[_projectId][_milestoneIdNext] = Milestone(_projectId, _amount, MilestoneStatus.PAID);
        if (_project.payType == PayType.MILESTONE) {
            uint256 _clientFee = calculateServiceFee(_amount, _project.clientFeePercent);
            _project.amountPaid += _amount;
            _project.amountClientFee += _clientFee;
            _deposit(_project.paymentToken, _msgSender(), _amount + _clientFee);
        }
    }

    /**
     *  @dev    Withdraw token from contract
     *
     *  @notice Transfer native coin or token to address
     *
     *          Name                Meaning
     *  @param  _receiver           Address of receiver
     *  @param  _paymentToken       Token address
     *  @param  _amount             Amount of native coin or token that want to transfer
     */
    function _withdraw(address _receiver, address _paymentToken, uint256 _amount) private {
        if (permittedPaymentTokens[_paymentToken]) {
            IERC20Upgradeable(_paymentToken).safeTransfer(_receiver, _amount);
        } else {
            Helper._transferNativeToken(_receiver, _amount);
        }
    }

    /**
     *  @dev    Deposit token from contract
     *
     *  @notice Transfer native coin or token to address
     *
     *          Name                Meaning
     *  @param  _paymentToken       Token address
     *  @param  _from               Address of sender
     *  @param  _amount             Amount of native coin or token that want to transfer
     */
    function _deposit(address _paymentToken, address _from, uint256 _amount) private {
        if (permittedPaymentTokens[_paymentToken]) {
            require(msg.value == 0, "Can only pay by token");
            IERC20Upgradeable(_paymentToken).safeTransferFrom(_from, address(this), _amount);
        } else {
            require(msg.value == _amount, "Invalid amount");
        }
    }
}
