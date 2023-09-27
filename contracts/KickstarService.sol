// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./lib/Helper.sol";

contract KickstarService is PausableUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    //  prettier-ignore
    /*
     *  @dev Project struct
     */
    struct Project {
        address       freelancer;               // Freelancer of project
        address       client;                   // Client of project
        address       paymentToken;             // Project token using in Project
        ProjectStatus status;                   // Project's status
        uint256       budget;              // Amount of all milestone
        uint256       amountPaid;              // The amount paid
        uint256       amountTax;              // The tax amount
        uint256       finishedMilestonesCount;  // Number of milestones
        uint256       lastMilestoneId;          // Last milestone id
        uint256       createdDate;              // Project's created day
        uint256       expiredDate;              // Project's expired day
        uint256[]     pendingMilestoneIds;      // List of milestone ids of this milestone
        uint256 clientFeePercent;               // Client fee percent
		uint256 freelancerFeePercent;           // Freelancer fee percent
        PayType payType;                       // Type of pay
		bool       	  isMultimilestone;             // Is multiple milestones
    }

    //  prettier-ignore
    /*
     *  @dev Milestone struct is information of milestone includes: created date, paid date, status
     */
    struct Milestone {
        uint256 expiredDate;                // Milestone's active date
		uint256 amount;                // Milestone's active date
        MilestoneStatus status;               // Milestone status
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                           Value
     *           |                               |
     *  Pay all                                 ALL
     *  Pay in milestone                        BYMILESTONE
     */
    enum PayType {
        ALL,
        HALF,
        BYMILESTONE
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                                              Value
     *           |                                                  |
     *  After Business Owner requests project                   REQUESTING
     *  After Client escrows money                              PAID
     *  When project is still in processing                     CLAIMING
     *  After the last milestone is completed                   FINISHED
     *  After Client stop project                            STOPPED
     */
    enum ProjectStatus {
        REQUESTING,
        PAID,
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
     *  After Business provide service to Client                                            FREELANCER_CONFIRMED
     *  After Client confirm to release money                                               CLIENT_CONFIRMED
     *  After Business Owner claim milestone                                                CLAIMED
     *  After Business Owner not provide service on time and fund is refunded to Client     CANCELED
     */
    enum MilestoneStatus {
        PENDING,
        PAID,
        FREELANCER_CONFIRMED,
        CLIENT_CONFIRMED,
        CLAIMED,
        CANCELED
    }

    uint256 public constant FEE_DENOMINATOR = 10000;

    /**
     *  @dev serviceFee uint256 is service fee of each project
     */
    uint256 public clientFeePercent = 1500;

    uint256 public freelancerFeePercent = 500;

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
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => bool) public permittedPaymentTokens;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => uint256) public feePercentOfAddress;

    event AcceptBid(
        uint256 indexed projectId,
        uint256 indexed milestoneId,
        address freelancer,
        address client,
        address paymentToken,
        uint256 budget,
        uint256 createdDate,
        uint256 expiredDate,
        ProjectStatus milestoneStatus,
        PayType payType,
        bool isMultimilestone
    );
    event Deposited(uint256 indexed projectId, ProjectStatus projectStatus);
    event ClientAcceptProject(uint256 indexed projectId);
    event ClientConfirmMilestone(uint256 indexed projectId, uint256 indexed milestoneId);
    event ConfirmedToRelease(uint256 indexed projectId, uint256 indexed milestoneId);
    event Claimed(
        uint256 indexed projectId,
        address indexed bo,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
        uint256[] milestoneIds,
        ProjectStatus projectStatus
    );
    event Stopped(
        address indexed bo,
        uint256 indexed projectId,
        uint256 amount,
        address paymentToken,
        ProjectStatus projectStatus
    );
    event Judged(
        uint256 indexed projectId,
        uint256[] indexed milestoneIds,
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
    event SetFeePercentToAddress(address indexed addr, uint256 feePercent);

    modifier onlyValidAddress(address _address) {
        uint32 size;
        assembly {
            size := extcodesize(_address)
        }
        require((size <= 0) && _address != address(0), "Invalid address");
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
        require(projects[_projectId].status != ProjectStatus.STOPPED, "Project is stopped");
        _;
    }

    modifier onlyRequestingProject(uint256 _projectId) {
        require(projects[_projectId].status == ProjectStatus.REQUESTING, "Project isn't requesting");
        _;
    }

    modifier onlyNonExpiredProject(uint256 _projectId) {
        require(block.timestamp <= projects[_projectId].expiredDate, "Project is expired");
        _;
    }

    /**
     *  @dev Initialize new contract.
     */
    function initialize(address _owner) public initializer {
        __Pausable_init();
        __Ownable_init();
        __ReentrancyGuard_init();

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

    function setFeePercentToAddress(address _addr, uint256 _feePercent) external whenNotPaused onlyOwner {
        require(_feePercent > 0 && _feePercent <= FEE_DENOMINATOR, "Invalid feePercent");
        feePercentOfAddress[_addr] = _feePercent;
        emit SetFeePercentToAddress(_addr, _feePercent);
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
     *  @dev    Create a new project
     *
     *  @notice Anyone can call this function.
     *
     *          Name                    Meaning
     *  @param  _freelancer                 Address of client
     *  @param  _paymentToken           Token contract address
     *  @param  _budget                 Total amount of project
     *  @param  _amountOfMilestones    Array of amount per installment of project
     *  @param  _expiredDateOfMilestones    Array of expired per date installment of project
     *  @param  _expiredDate            Project's expired date
     *  @param  _payType            Type of pay
     *  @param  _isMultimilestone            Multimilestone
     *
     *  Emit event {AcceptBid}
     */
    function acceptBid(
        address _freelancer,
        address _paymentToken,
        uint256 _budget,
        uint256 _expiredDate,
        uint256[] memory _amountOfMilestones,
        uint256[] memory _expiredDateOfMilestones,
        PayType _payType,
        bool _isMultimilestone
    ) external payable whenNotPaused {
        require(_msgSender() != _freelancer, "Freelancer can not be same");
        require(permittedPaymentTokens[_paymentToken] == true || _paymentToken == address(0), "Invalid project token");
        require(_budget > 0, "Amount per installment must be greater than 0");
        if (_isMultimilestone) {
            require(_payType != PayType.HALF, "Invalid pay type");
            require(
                _amountOfMilestones.length > 0 && _amountOfMilestones.length == _expiredDateOfMilestones.length,
                "Invalid length"
            );
        } else {
            require(
                _amountOfMilestones.length == 1 && _amountOfMilestones.length == _expiredDateOfMilestones.length,
                "Job is not multimilestone"
            );
        }

        uint256 currentTime = block.timestamp;
        require(_expiredDate > currentTime, "Invalid expired date");

        lastProjectId++;
        Project storage project = projects[lastProjectId];
        project.client = _msgSender();
        project.freelancer = _freelancer;
        project.paymentToken = _paymentToken;
        project.budget = _budget;
        project.isMultimilestone = _isMultimilestone;
        project.createdDate = currentTime;
        project.expiredDate = _expiredDate;
        project.payType = _payType;
        project.clientFeePercent = feePercentOfAddress[_msgSender()] > 0
            ? feePercentOfAddress[_msgSender()]
            : clientFeePercent;
        project.freelancerFeePercent = feePercentOfAddress[_freelancer] > 0
            ? feePercentOfAddress[_freelancer]
            : freelancerFeePercent;

        uint256 _totalValue = 0;
        MilestoneStatus _milestoneStatus = MilestoneStatus.PENDING;
        if (_payType == PayType.ALL) {
            project.status = ProjectStatus.PAID;
            project.amountPaid = _budget;
            _milestoneStatus = MilestoneStatus.PAID;
        } else if (_payType == PayType.HALF) {
            project.amountPaid = _budget / 2;
            _milestoneStatus = MilestoneStatus.PAID;
        } else {
            project.amountPaid = _amountOfMilestones[0];
        }

        project.amountTax = calculateServiceFee(project.budget, clientFeePercent);

        for (uint256 i = 0; i < _amountOfMilestones.length; i++) {
            require(_amountOfMilestones[i] > 0, "Invalid amount of milestone");
            require(_expiredDateOfMilestones[i] > currentTime, "Invalid expired date of milestone");
            if (i > 0) {
                require(
                    _expiredDateOfMilestones[i] > _expiredDateOfMilestones[i - 1],
                    "Expired date of milestone after must be greater than before"
                );
            }
            _totalValue += _amountOfMilestones[i];
            milestones[lastProjectId][project.lastMilestoneId] = Milestone(
                _expiredDateOfMilestones[i],
                _amountOfMilestones[i],
                _milestoneStatus
            );
            project.lastMilestoneId++;
        }
        require(_totalValue == _budget, "Invalid total amount");

        // change status milestone index 0
        if (_payType == PayType.BYMILESTONE) {
            milestones[lastProjectId][0].status = MilestoneStatus.PAID;
        }

        _deposit(project.paymentToken, _msgSender(), project.amountPaid + project.amountTax);

        emit AcceptBid(
            lastProjectId,
            project.lastMilestoneId,
            _freelancer,
            _msgSender(),
            _paymentToken,
            _budget,
            currentTime,
            _expiredDate,
            project.status,
            _payType,
            _isMultimilestone
        );
    }

    /**
     *  @dev    Client cancels project according to "Right to Stop"
     *
     *  @notice Only Client can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that client want to cancel
     *
     *  Emit event {Stopped}
     */
    function stopProject(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyClient(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        require(
            project.status == ProjectStatus.REQUESTING || project.status == ProjectStatus.PAID,
            "Project has processed"
        );

        project.status = ProjectStatus.STOPPED;
        uint256 _totalAmount = project.amountPaid + project.amountTax;

        if (project.amountPaid > 0) {
            _withdraw(project.client, project.paymentToken, _totalAmount);
        }

        emit Stopped(project.client, _projectId, _totalAmount, project.paymentToken, project.status);
    }

    /**
     *  @dev    Freelancer accept that provides service of Client
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name        Meaning
     *  @param  _projectId  ID of project that needs to be updated
     *
     *  Emit event {ClientConfirmMilestones}
     */
    function clientAcceptProject(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyNonExpiredProject(_projectId) onlyFreelancer(_projectId) {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.REQUESTING, "Project isn't processing");
        project.status = ProjectStatus.PROCESSING;

        emit ClientAcceptProject(_projectId);
    }

    /**
     *  @dev    Client confirm that provides service to Client
     *
     *  @notice Only Client Owner can call this function.
     *
     *          Name        Meaning
     *  @param  _projectId  ID of project that needs to be updated
     *
     *  Emit event {ClientConfirmMilestone}
     */
    function clientConfirmMilestone(
        uint256 _projectId,
        uint256 _milestoneId
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

        if (project.payType == PayType.HALF) {
            uint256 _amountToPay = project.budget - project.amountPaid;
            project.amountPaid = project.budget;
            _deposit(project.paymentToken, _msgSender(), _amountToPay);
        }

        require(_milestoneId < project.lastMilestoneId, "Invalid milestoneId");
        Milestone storage milestone = milestones[_projectId][_milestoneId];
        require(
            milestone.status == MilestoneStatus.FREELANCER_CONFIRMED,
            "This milestone has not been confirmed by freelancer"
        );
        milestone.status = MilestoneStatus.CLIENT_CONFIRMED;
        project.pendingMilestoneIds.push(_milestoneId);

        // pay type = half is only one milestone
        // check if type is all or milestone
        if (_milestoneId < project.lastMilestoneId - 1) {
            Milestone storage milestoneNext = milestones[_projectId][_milestoneId + 1];
            if (milestoneNext.status == MilestoneStatus.PENDING) {
                uint256 _amountToPay = milestoneNext.amount;
                project.amountPaid += _amountToPay;
                milestoneNext.status = MilestoneStatus.PAID;
                _deposit(project.paymentToken, _msgSender(), _amountToPay);
            }
        }

        emit ClientConfirmMilestone(_projectId, _milestoneId);
    }

    /**
     *  @dev    Freelancer confirm to release milestone
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name          Meaning
     *  @param  _projectId    ID of project that needs to be confirmed
     *
     *  Emit event {ConfirmedToRelease}
     */
    function confirmToRelease(
        uint256 _projectId,
        uint256 _milestoneId
    ) external whenNotPaused onlyValidProject(_projectId) onlyNonExpiredProject(_projectId) onlyFreelancer(_projectId) {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project isn't processing");

        require(_milestoneId < project.lastMilestoneId, "Invalid milestoneId");
        Milestone storage milestone = milestones[_projectId][_milestoneId];
        if (project.payType != PayType.HALF) {
            require(milestone.status == MilestoneStatus.PAID, "Milestone status is not paid");
        }
        milestone.status = MilestoneStatus.FREELANCER_CONFIRMED;

        emit ConfirmedToRelease(_projectId, _milestoneId);
    }

    /**
     *  @dev    Business Owner claim all milestones of project
     *
     *  @notice Only Business Owner can call this function.
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
        require(block.timestamp <= project.expiredDate, "Claim time has expired");
        require(project.pendingMilestoneIds.length > 0, "Nothing to claim");

        uint256 claimableTotalAmount = 0;
        // Set CLAIMED status for claimed milestone
        for (uint256 i = 0; i < project.pendingMilestoneIds.length; ++i) {
            uint256 milestoneId = project.pendingMilestoneIds[i];
            milestones[_projectId][milestoneId].status = MilestoneStatus.CLAIMED;
            claimableTotalAmount += milestones[_projectId][milestoneId].amount;
        }

        project.finishedMilestonesCount += project.pendingMilestoneIds.length;
        if (project.finishedMilestonesCount == project.lastMilestoneId) {
            project.status = ProjectStatus.FINISHED;
        }

        uint256[] memory pendingMilestoneIdsBefore = project.pendingMilestoneIds;
        project.pendingMilestoneIds = new uint256[](0);

        // Calculate fee and transfer tokens
        uint256 serviceFee = calculateServiceFee(claimableTotalAmount, project.freelancerFeePercent);
        uint256 claimableAmount = claimableTotalAmount - serviceFee;

        _withdraw(_msgSender(), project.paymentToken, claimableAmount);
        _withdraw(owner(), project.paymentToken, serviceFee);

        emit Claimed(
            _projectId,
            _msgSender(),
            project.paymentToken,
            claimableAmount,
            serviceFee,
            pendingMilestoneIdsBefore,
            project.status
        );
    }

    /**
     *  @dev    Return money for Client if Business Owner not provide services on time in a milestone
     *
     *  @notice Only Owner (KickstarService) can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that Owner (KickstarService) want to handle
     *  @param  _milestoneIds       ID of milestones that want to judge
     *  @param  _isCancel           true -> Client win -> cancel this milestone; false -> BO win -> force client to confirm this milestone
     *
     *  Emit event {Judged}
     */
    function judge(
        uint256 _projectId,
        uint256[] memory _milestoneIds,
        bool _isCancel
    ) external whenNotPaused onlyValidProject(_projectId) onlyOwner nonReentrant {
        require(_milestoneIds.length > 0, "Invalid milestone ids");

        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project hasn't been processing yet");

        for (uint256 i = 0; i < _milestoneIds.length; i++) {
            uint256 milestoneId = _milestoneIds[i];
            Milestone storage milestone = milestones[_projectId][milestoneId];
            require(milestone.status == MilestoneStatus.FREELANCER_CONFIRMED, "Milestone hasn't confirm yet");

            if (_isCancel) {
                project.finishedMilestonesCount++;
                milestone.status = MilestoneStatus.CANCELED;
                if (project.payType == PayType.HALF) {
                    project.status = ProjectStatus.STOPPED;
                    _withdraw(project.client, project.paymentToken, project.amountPaid + project.amountTax);
                } else {
                    _withdraw(project.client, project.paymentToken, milestone.amount);
                }
            } else {
                milestone.status = MilestoneStatus.CLIENT_CONFIRMED;
                project.pendingMilestoneIds.push(milestoneId);
            }
        }

        emit Judged(_projectId, _milestoneIds, _isCancel, project.status);
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
     *  @dev    Get pending milestone ids that waiting for BO claim from project by project id
     *
     *          Name                Meaning
     *  @param  _projectId          Project id that milestone ids are belong to
     *
     *  @return Pending milestone ids that waiting for BO claim
     */
    function getPendingMilestoneIds(uint256 _projectId) external view returns (uint256[] memory) {
        return projects[_projectId].pendingMilestoneIds;
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

    function _deposit(address _paymentToken, address _from, uint256 _amount) private {
        if (permittedPaymentTokens[_paymentToken]) {
            require(msg.value == 0, "Can only pay by token");
            IERC20Upgradeable(_paymentToken).safeTransferFrom(_from, address(this), _amount);
        } else {
            require(msg.value == _amount, "Invalid amount");
        }
    }
}
