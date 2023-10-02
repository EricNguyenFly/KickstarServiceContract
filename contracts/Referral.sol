// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IReferral.sol";

contract Referral is IReferral, Ownable {
    uint256 public constant FEE_DENOMINATOR = 10000;

    mapping(address => uint256) private referrers;

    event SetReferrer(address indexed referrer, uint256 disscountPercent);

    constructor(address _newOwner) {
        _transferOwnership(_newOwner);
    }

    /*------------------Common Checking------------------*/

    modifier notZeroAddress(address _account) {
        require(_account != address(0), "Invalid address");
        _;
    }

    modifier notZeroPercent(uint256 _percent) {
        require(_percent > 0 && _percent <= FEE_DENOMINATOR, "Invalid percent");
        _;
    }

    function setReferrers(address[] memory _accounts, uint256[] memory _disscountPercents) external onlyOwner {
        require(_accounts.length > 0 && _accounts.length == _disscountPercents.length, "Invalid length");
        for (uint256 i = 0; i < _accounts.length; i++) {
            setReferrer(_accounts[i], _disscountPercents[i]);
        }
    }

    function setReferrer(
        address _account,
        uint256 _disscountPercent
    ) public onlyOwner notZeroAddress(_account) notZeroPercent(_disscountPercent) {
        referrers[_account] = _disscountPercent;
        emit SetReferrer(_account, _disscountPercent);
    }

    function getReferrer(address _account) external returns (uint256) {
        return referrers[_account];
    }
}
